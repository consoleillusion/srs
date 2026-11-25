/**
 * How queries name a resource's rows. A table's rows are read from the base
 * table itself, aliased with the resource's view name, never through the view:
 * a condition on a view's column cannot use the table's indexes, so every
 * lookup would read every row (design book, Efficiency). An authored view has
 * no base table of its own and is read as the view.
 *
 * @module
 */
import { apiName, quote, viewValue } from '../db/views.ts'
import type { ResourceMeta } from './registry.ts'
import type { Scope } from './scope.ts'
import { uuidToBuffer } from './uuid.ts'

/**
 * The FROM item for a resource's rows.
 *
 * @param resource - The resource.
 * @param alias - The alias its conditions use.
 */
export const fromSql =
  (resource: ResourceMeta, alias: string) =>
    `${quote(resource.readOnly ? resource.view : resource.table)} AS ${quote(alias)}`

/**
 * The stored key of a row: what the primary key index finds rows by.
 *
 * @param resource - The resource.
 * @param alias - The row's alias.
 */
export const keySql =
  (resource: ResourceMeta, alias: string) =>
    `${quote(alias)}.${quote(resource.readOnly ? '_key' : resource.definition.idColumn)}`

/**
 * A condition that the row is owned by the user, comparing stored values so
 * the owner index is used.
 *
 * @param resource - The resource.
 * @param alias - The row's alias.
 * @param userId - The user's canonical uuid.
 */
export const ownedBy =
  (resource: ResourceMeta, alias: string, userId: string): Scope => (
    { sql: `${quote(alias)}.\`owner\` = ?`
    , params: [resource.readOnly ? userId : uuidToBuffer(userId)]
    })

/**
 * A column as the API shows it (uuids as text), for filters on it.
 *
 * @param resource - The resource.
 * @param alias - The row's alias.
 * @param field - The column's name in the API.
 * @returns The SQL expression, or undefined for an unknown field.
 */
export const columnSql =
  (resource: ResourceMeta, alias: string, field: string) => {
    if (resource.readOnly) return `${quote(alias)}.${quote(field)}`
    const column = resource.definition.columns.find(x => apiName(resource.definition, x) === field)
    return column ? viewValue(column, alias) : undefined
  }

/**
 * A column in its stored form, for sorting: the order is the same as the API
 * form's, and the stored column can use an index.
 *
 * @param resource - The resource.
 * @param alias - The row's alias.
 * @param field - The column's name in the API.
 */
export const sortSql =
  (resource: ResourceMeta, alias: string, field: string) =>
    resource.readOnly ? `${quote(alias)}.${quote(field)}`
    : field === 'id' ? keySql(resource, alias)
    : `${quote(alias)}.${quote(field)}`
