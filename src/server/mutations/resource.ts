import type { Row } from '../database.ts'
import { badRequest, forbidden, notFound } from '../errors.ts'
import { idFromDb, idKindOf, idToDb, keyCondition } from '../ids.ts'
import type { ResourceMeta } from '../registry.ts'
import { deleteScope, granted, readScope, writeScope } from '../scope.ts'
import { insert, remove, update } from '../sql.ts'
import { uuidToBuffer } from '../uuid.ts'
import { type MutationContext, viewerIn, type WriteDocument } from './types.ts'
import { assertRequiredAttributes, attributeAssignments, foreignKeyAssignments, writeError } from './assign.ts'
import { readResourceRow } from './row.ts'
import { assertRelationshipTargets, assertRequiredMany, replaceManyRelationships } from './relationships.ts'

/** Refuse creation of resources the server alone creates, or that need a role the caller lacks. */
export const assertMayCreate =
  (context: MutationContext, resource: ResourceMeta) => {
    if (resource.access.create === 'none')
      throw forbidden(`"${resource.type}" rows are created by the server, not through the API`)
    if (resource.access.create === 'role'
        && (context.userId !== undefined || context.anonymous)
        && !granted(viewerIn(context), resource, 'create'))
      throw forbidden(`Creating "${resource.type}" needs a role that allows it`)
  }

/**
 * The error for a row the caller may not change: 403 when they can read it,
 * because pretending it does not exist would be a lie to someone who just saw
 * it; 404 otherwise, so a row they cannot read stays invisible.
 */
export const notWritable =
  async (context: MutationContext, resource: ResourceMeta, id: string, action: string) =>
    await readResourceRow(context.db, resource, id, readScope(viewerIn(context), resource, context.registry))
      ? forbidden(`You may read this ${resource.type} but not ${action} it`)
      : notFound(`Resource "${resource.type}" with id "${id}" was not found`)

export const createResource =
  async ( context: MutationContext
  , resource: ResourceMeta
  , document: WriteDocument): Promise<string> => {
    assertMayCreate(context, resource)
    assertRequiredAttributes(
      resource, new Set(Object.keys(document.attributes)))
    assertRequiredMany(resource, document, 'create')
    await assertRelationshipTargets(context, resource, document)

    const table = resource.definition
    // A text key has no generator: the client names the row.
    if (!document.id && idKindOf(table) === 'string')
      throw badRequest(`"${resource.type}" rows are named by the client: send "data.id"`, 'data.id')
    const assignments =
      { ...(document.id ? keyCondition(table, document.id) : {})
      , ...await attributeAssignments(context, resource, document, 'create')
      , ...(context.userId !== undefined
          ? { owner: uuidToBuffer(context.userId) }
          : {})
      , ...foreignKeyAssignments(resource, document, 'create')
      }

    let inserted: Row | undefined
    try {
      inserted = await insert(context.db, resource.table, assignments, table.idColumn, idKindOf(table) === 'uuid')
    } catch (error) {
      throw writeError(error)
    }

    const id = idFromDb(table, inserted?.[table.idColumn])
    await replaceManyRelationships(context, resource, id, document, 'create')
    return id
  }

export const updateResource =
  async ( context: MutationContext
  , resource: ResourceMeta
  , id: string
  , document: WriteDocument
  , mode: 'patch' | 'put'): Promise<void> => {
    const existing =
      await readResourceRow(
        context.db, resource, id, writeScope(viewerIn(context), resource))
    if (!existing) throw await notWritable(context, resource, id, 'change')
    context =
      { ...context
      , isOwner:
          context.userId === undefined
          || existing.owner === context.userId
          || granted(viewerIn(context), resource, 'update')
      }
    assertRequiredMany(resource, document, mode)
    await assertRelationshipTargets(context, resource, document)

    const assignments =
      { ...await attributeAssignments(context, resource, document, mode)
      , ...foreignKeyAssignments(resource, document, mode)
      }

    if (Object.keys(assignments).length > 0) {
      try {
        await update(
          context.db, resource.table, assignments, keyCondition(resource.definition, id))
      } catch (error) {
        throw writeError(error)
      }
    }

    await replaceManyRelationships(context, resource, id, document, mode)
  }

export const deleteResource =
  async ( context: MutationContext
  , resource: ResourceMeta
  , id: string): Promise<void> => {
    const existing =
      await readResourceRow(
        context.db, resource, id, deleteScope(viewerIn(context), resource))
    if (!existing) throw await notWritable(context, resource, id, 'delete')

    const key = idToDb(resource.definition, id)

    for (const table of context.built.orderedTables) {
      if (!table.derived) continue

      for (const foreignKey of table.foreignKeys) {
        if (foreignKey.foreignTable !== resource.table) continue
        await remove(
          context.db, table.tableName, { [foreignKey.columns[0]!]: key })
      }
    }

    try {
      await remove(context.db, resource.table, keyCondition(resource.definition, id))
    } catch (error) {
      throw writeError(error)
    }
  }
