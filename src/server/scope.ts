import type { AppContext, Next } from './context.ts'
import type { Operation } from '../db/schema-types.ts'
import { quote } from '../db/views.ts'
import type { TableDef } from '../db/schema-types.ts'
import { keyParam } from './ids.ts'
import { fromSql, keySql, ownedBy } from './rows.ts'
import type { Row, RowDatabase } from './database.ts'
import type { Registry, ResourceMeta } from './registry.ts'
import { uuidToBuffer } from './uuid.ts'

/**
 * userId set: signed in. anonymous: no session on an x-access "public" operation.
 * Neither: the server runs without sessions and applies no scoping.
 * signed: this request carried a valid signature.
 */
export type Viewer =
  { userId?: string
  , anonymous?: boolean
  , roles?: string[]
  , signed?: boolean
  }

/**
 * An empty sql means "no restriction".
 */
export type Scope = { sql: string, params: unknown[] }

const NONE: Scope = { sql: '', params: [] }
const NEVER: Scope = { sql: '0', params: [] }
const MAX_INHERIT_DEPTH = 3

type Grant = 'can_read' | 'can_write'

export const viewerOf =
  (c: AppContext): Viewer => (
    { userId: c.get('userId')
    , anonymous: c.get('anonymous') === true
    , roles: c.get('roles') ?? []
    , signed: c.get('signed') === true
    })

/** Report whether one of the viewer's roles allows the operation on every row. */
export const granted =
  (viewer: Viewer, resource: ResourceMeta, operation: Operation) =>
    Object.entries(resource.access.roles).some(
      ([role, operations]) =>
        operations.includes(operation) && viewer.roles?.includes(role) === true)

/** SQL that is true when a share grants this user (or one of their groups) the permission. */
const sharedWith =
  (definition: TableDef, rowId: string, userId: string, grant: Grant): Scope => {
    const user = uuidToBuffer(userId)
    const table = definition.tableName
    return (
      { sql:
          `EXISTS (SELECT 1 FROM ${quote(`${table}_share`)} AS \`s\``
          + ` WHERE \`s\`.${quote(`${table}_id`)} = ${rowId}`
          + ` AND \`s\`.${quote(grant)}`
          + ' AND (`s`.`user_id` = ? OR `s`.`user_group_id` IN'
          + ' (SELECT `m`.`user_group_id` FROM `user_group_membership` AS `m`'
          + ' WHERE `m`.`user_id` = ?)))'
      , params: [user, user]
      })
  }

/** OR scopes together; an unrestricted scope makes the result unrestricted. */
const anyOf =
  (scopes: Scope[]): Scope => {
    if (scopes.some(x => x.sql === '')) return NONE
    return (
      { sql: `(${scopes.map(x => x.sql).join(' OR ')})`
      , params: scopes.flatMap(x => x.params)
      })
  }

export const readScope =
  ( viewer: Viewer
  , resource: ResourceMeta
  , registry: Registry
  , alias = resource.view
  /** Restrict reads to rows the viewer owns, may see by visibility, share, role or parent. */
  , depth = 0): Scope => {
    if (!viewer.userId && !viewer.anonymous) return NONE
    if (resource.access.signed.includes('read') && !viewer.signed) return NEVER
    if (granted(viewer, resource, 'read')) return NONE

    const a = quote(alias)
    const scopes: Scope[] = []

    if (viewer.userId) {
      const owned = ownedBy(resource, alias, viewer.userId)
      scopes.push(
        { sql: `${owned.sql} OR ${a}.\`visibility\` IN ('public', 'authenticated')`
        , params: owned.params
        })
      if (resource.access.shareable) {
        const shared =
          sharedWith(resource.definition, keySql(resource, alias), viewer.userId, 'can_read')
        scopes.push(
          { sql: `(${a}.\`visibility\` = 'shared' AND ${shared.sql})`
          , params: shared.params
          })
      }
    } else if (resource.access.read === 'public')
      scopes.push({ sql: `${a}.\`visibility\` = 'public'`, params: [] })

    const relation =
      resource.access.inherit
        ? resource.definition.relations[resource.access.inherit]
        : undefined
    const parent = relation ? registry.get(relation.table) : undefined
    if (relation?.foreignKey && parent && depth < MAX_INHERIT_DEPTH) {
      const p = `p${depth}`
      const inner = readScope(viewer, parent, registry, p, depth + 1)
      scopes.push(
        { sql:
            `EXISTS (SELECT 1 FROM ${fromSql(parent, p)}`
            // Stored key against stored foreign key, so the parent is found by its index.
            + ` WHERE ${keySql(parent, p)} = ${a}.${quote(relation.foreignKey)}`
            + (inner.sql ? ` AND ${inner.sql}` : '')
            + ')'
        , params: inner.params
        })
    }

    return scopes.length === 0 ? NEVER : anyOf(scopes)
  }

/** Restrict updates to rows the user owns, holds a write share on, or has a role for. */
export const writeScope =
  (viewer: Viewer, resource: ResourceMeta): Scope => {
    if (!viewer.userId) return viewer.anonymous ? NEVER : NONE
    if (granted(viewer, resource, 'update')) return NONE

    const scopes: Scope[] = [ownedBy(resource, resource.view, viewer.userId)]
    if (resource.access.shareable)
      scopes.push(
        sharedWith(resource.definition, keySql(resource, resource.view), viewer.userId, 'can_write'))
    return anyOf(scopes)
  }

/** Restrict deletes to rows the user owns or has a role for. */
export const deleteScope =
  (viewer: Viewer, resource: ResourceMeta): Scope => {
    if (!viewer.userId) return viewer.anonymous ? NEVER : NONE
    if (granted(viewer, resource, 'delete')) return NONE
    return ownedBy(resource, resource.view, viewer.userId)
  }

/** Decide from the row alone whether it is readable; undefined means "ask the database". */
const quickRead =
  (viewer: Viewer, resource: ResourceMeta, row: Row): boolean | undefined => {
    if (!viewer.userId && !viewer.anonymous) return true
    if (resource.access.signed.includes('read') && !viewer.signed) return false
    if (viewer.userId
        && (row.owner === viewer.userId
            || row.visibility === 'public'
            || row.visibility === 'authenticated'))
      return true
    if (viewer.anonymous
        && resource.access.read === 'public'
        && row.visibility === 'public')
      return true

    const { shareable, inherit, roles } = resource.access
    return shareable || inherit || Object.keys(roles).length > 0 ? undefined : false
  }

export type RowReader = (table: string, rows: Row[]) => Promise<Row[]>

export const createReader =
  (db: RowDatabase, viewer: Viewer, registry: Registry): RowReader =>
    /** Keep only the embedded rows this viewer may read. */
    async (table, rows) => {
      const resource = registry.get(table)
      if (!resource) return []

      const result: Row[] = []
      for (const row of rows) {
        let readable = quickRead(viewer, resource, row)
        if (readable === undefined) {
          const scope = readScope(viewer, resource, registry)
          readable =
            await db.get(
              `SELECT 1 AS found FROM ${fromSql(resource, resource.view)} WHERE ${keySql(resource, resource.view)} = ?`
              + (scope.sql ? ` AND ${scope.sql}` : '')
              , [keyParam(resource.definition, String(row.id)), ...scope.params]) !== undefined
        }
        if (readable) result.push(row)
      }
      return result
    }
