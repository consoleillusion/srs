import type { ColumnDef, TableDef } from '../db/schema-types.ts'
import { apiName, quote, relationJoin, selectSql } from '../db/views.ts'
import { keyParam } from './ids.ts'
import { columnSql, fromSql, keySql, sortSql } from './rows.ts'
import type { Row, RowDatabase } from './database.ts'
import { badRequest } from './errors.ts'
import type { FilterField, ListQuery } from './query.ts'
import type { ResourceMeta } from './registry.ts'
import type { Scope } from './scope.ts'

export type Tables = Map<string, TableDef>

/** The relation's JOINs, reading each endpoint from its base table when it is a view. */
const relationSource =
  (resource: ResourceMeta) =>
    resource.readOnly
      ? resource.definition.sourceTable ?? resource.table
      : resource.table

/**
 * The SELECT of a resource's rows, straight from its base table aliased with
 * the view's name, embedding only the relations this request needs. Conditions
 * then go in this query's own WHERE, where the table's indexes apply.
 */
export const rowSelect =
  (tables: Tables, resource: ResourceMeta, query?: Pick<ListQuery, 'fields' | 'include'>) => {
    if (resource.readOnly)
      return `SELECT * FROM ${fromSql(resource, resource.view)}`

    const selection = query?.fields.get(resource.type)
    return selectSql(
      resource.definition
      , tables
      , label =>
          !query ? 'full'
          : !resource.relationships[label] ? 'none'
          : query.include.includes(label) ? 'full'
          : !selection || selection.has(label) ? 'light'
          : 'none'
      , resource.view)
  }

/** Convert a filter's text value to the column's stored type. */
const filterValue =
  (column: ColumnDef, key: string, raw: string): unknown => {
    /** Raise the 400 for a value of the wrong type. */
    const fail = (expected: string): never => {
      throw badRequest(`Filter "${key}" expects ${expected}`, key)
    }
    const { type, format } = column.schema
    if (format === 'date-time') {
      const time = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw)
      return Number.isFinite(time) ? time : fail('a date-time')
    }
    if (type === 'integer' || type === 'number') {
      const value = Number(raw)
      return raw.trim() !== '' && Number.isFinite(value) ? value : fail('a number')
    }
    if (type === 'boolean')
      return raw === 'true' ? 1 : raw === 'false' ? 0 : fail('true or false')
    return raw
  }

const escapeLike =
  (value: string) => value.replace(/[\\%_]/g, x => `\\${x}`)

const comparison: Record<string, string> =
  { eq: '=', ne: '<>', gt: '>', ge: '>=', lt: '<', le: '<=' }

/** The condition of one filter on a column of the view aliased `alias`. */
const columnScope =
  (resource: ResourceMeta, alias: string, filter: FilterField): Scope => {
    const { key, field, operator, value } = filter
    const column = resource.definition.columns.find(x => apiName(resource.definition, x) === field)!
    const name = columnSql(resource, alias, field)!
    const typed = (raw: string) => filterValue(column, key, raw)

    if (comparison[operator])
      return { sql: `${name} ${comparison[operator]} ?`, params: [typed(value)] }
    if (operator === 'in' || operator === 'nin') {
      const values = value.split(',').map(typed)
      return (
        { sql:
            `${name} ${operator === 'in' ? 'IN' : 'NOT IN'}`
            + ` (${values.map(() => '?').join(', ')})`
        , params: values
        })
    }
    if (operator === 'null') {
      if (value !== 'true' && value !== 'false')
        throw badRequest(`Filter "${key}" null expects true or false`, key)
      return { sql: `${name} IS ${value === 'true' ? '' : 'NOT '}NULL`, params: [] }
    }

    const pattern =
      { contains: `%${escapeLike(value)}%`
      , starts: `${escapeLike(value)}%`
      , ends: `%${escapeLike(value)}`
      }[operator]
    return { sql: `${name} LIKE ? ESCAPE '\\'`, params: [pattern] }
  }

/** Which related rows a viewer may see, as a condition on a view alias. */
export type ScopeFor = (resource: ResourceMeta, alias: string) => Scope

/**
 * The condition of one filter. A filter through relationships holds when at
 * least one related row the viewer may read matches, so rows they cannot read
 * never affect the result.
 */
const filterScope =
  ( tables: Tables
  , filter: FilterField
  , scopeFor: ScopeFor
  , resource: ResourceMeta
  , alias: string
  , step = 0): Scope => {
    const hop = filter.path[step]
    if (!hop) return columnScope(resource, alias, filter)

    const [s, t, j, f] = ['s', 't', 'j', 'f'].map(x => `${x}${step}`) as [string, string, string, string]
    const relation = hop.from.definition.relations[hop.label]!
    const readable = scopeFor(hop.to, f)
    const inner = filterScope(tables, filter, scopeFor, hop.to, f, step + 1)
    const fromTable = relationSource(hop.from)
    const toTable = hop.to.view
    const correlated =
      { sql: `${quote(s)}.${quote(tables.get(fromTable)!.idColumn)} = ${keySql(resource, alias)}`, params: [] }
    const where = whereSql([correlated, readable, inner])
    return (
      { sql:
          `EXISTS (SELECT 1 FROM ${quote(fromTable)} AS ${quote(s)} `
          + relationJoin(
              hop.from.definition, relation, tables, s, t, j, fromTable)
          + ` JOIN ${fromSql(hop.to, f)}`
          + ` ON ${keySql(hop.to, f)} = ${quote(t)}.${quote(tables.get(relation.table)!.idColumn)}`
          + `${where.sql})`
      , params: where.params
      })
  }

/** AND the non-empty scopes into a WHERE clause with its parameters. */
const whereSql =
  (scopes: Scope[]) => {
    const active = scopes.filter(x => x.sql !== '')
    return (
      { sql: active.length ? ` WHERE ${active.map(x => `(${x.sql})`).join(' AND ')}` : ''
      , params: active.flatMap(x => x.params)
      })
  }

export const listRows =
  async ( db: RowDatabase
  , tables: Tables
  , resource: ResourceMeta
  , query: ListQuery
  , scopes: Scope[]
  /** Run a filtered, sorted, paginated list and return the page with the total count. */
  , scopeFor: ScopeFor) => {
    const where =
      whereSql(
        [ ...query.filters.map(x => filterScope(tables, x, scopeFor, resource, resource.view))
        , ...scopes
        ])
    const order =
      query.sort.length > 0
        ? query.sort
            .map(x => `${sortSql(resource, resource.view, x.field)} ${x.direction.toUpperCase()}`)
            .join(', ')
        : `${keySql(resource, resource.view)} ASC`

    // Counting reads every matching row, so a client that needs no total can skip it (page[total]=false).
    const total =
      query.total
        ? Number(
            (await db.get(
              `SELECT COUNT(*) AS count FROM ${fromSql(resource, resource.view)}${where.sql}`
              , where.params))
              ?.count ?? 0)
        : undefined
    // Without a total, one extra row says whether there is a next page.
    const rows =
      await db.all(
        `${rowSelect(tables, resource, query)}${where.sql}`
        + ` ORDER BY ${order} LIMIT ? OFFSET ?`
        , [ ...where.params
          , query.pageSize + (total === undefined ? 1 : 0)
          , (query.pageNumber - 1) * query.pageSize
          ])
    const more = rows.length > query.pageSize
    return { rows: more ? rows.slice(0, query.pageSize) : rows, total, more }
  }

export const readRow =
  ( db: RowDatabase
  , tables: Tables
  , resource: ResourceMeta
  , query: ListQuery
  , id: string
  /** Read one row by id if it passes the scope. */
  , scope: Scope): Promise<Row | undefined> => {
    const where =
      whereSql([{ sql: `${keySql(resource, resource.view)} = ?`, params: [keyParam(resource.definition, id)] }, scope])
    return db.get(
      `${rowSelect(tables, resource, query)}${where.sql} LIMIT 1`
      , where.params)
  }

const ID_CHUNK = 500

/** Read the rows with these ids that pass the scope, embedding the relations the query includes. */
export const readRowsByIds =
  async ( db: RowDatabase
  , tables: Tables
  , resource: ResourceMeta
  , query: Pick<ListQuery, 'fields' | 'include'>
  , ids: string[]
  , scope: Scope) => {
    const rows: Row[] = []
    for (let start = 0; start < ids.length; start += ID_CHUNK) {
      const chunk = ids.slice(start, start + ID_CHUNK)
      const where =
        whereSql(
          [ { sql: `${keySql(resource, resource.view)} IN (${chunk.map(() => '?').join(', ')})`
            , params: chunk.map(x => keyParam(resource.definition, x))
            }
          , scope
          ])
      rows.push(
        ...await db.all(
          `${rowSelect(tables, resource, query)}${where.sql}`, where.params))
    }
    return rows
  }
