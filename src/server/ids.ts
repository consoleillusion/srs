/**
 * Resource ids. A table is keyed by its generated uuid `id` column, or by the
 * property its schema marks `x-primary` (design book, Schema). In documents and
 * URLs an id is always a string; these helpers convert it to and from the value
 * stored in the key column.
 *
 * @module
 */
import { reference, uuidString } from '../db/views.ts'
import type { TableDef } from '../db/schema-types.ts'
import { canonicalUuid, UUID_PATTERN, uuidToBuffer } from './uuid.ts'

/** How a table's key is stored: a 16-byte uuid, an integer, or text. */
export type IdKind = 'uuid' | 'integer' | 'string'

const INTEGER_PATTERN = /^-?(0|[1-9][0-9]{0,18})$/

/**
 * How a table's key column is stored.
 *
 * @param table - The table.
 */
export const idKindOf =
  (table: TableDef): IdKind => {
    const column = table.columns.find(x => x.columnName === table.idColumn)
    if (!column || column.schema.format === 'uuid') return 'uuid'
    return column.schema.type === 'integer' ? 'integer' : 'string'
  }

/**
 * Whether a string can be an id of a table: a canonical uuid, a decimal integer
 * without leading zeros, or any non-empty text up to 255 characters.
 *
 * @param table - The table.
 * @param value - The id from a URL or a document.
 */
export const isValidId =
  (table: TableDef, value: string): boolean => {
    const kind = idKindOf(table)
    if (kind === 'uuid') return UUID_PATTERN.test(value)
    if (kind === 'integer') return INTEGER_PATTERN.test(value) && Number.isSafeInteger(Number(value))
    return value.length > 0 && value.length <= 255
  }

/**
 * The canonical form of a valid id: uuids are lower-cased, others are unchanged.
 *
 * @param table - The table.
 * @param value - A valid id.
 */
export const canonicalId =
  (table: TableDef, value: string): string =>
    idKindOf(table) === 'uuid' ? value.toLowerCase() : value

/**
 * The value to store or compare in the table's key column, and in foreign keys that reference it.
 *
 * @param table - The table.
 * @param value - A valid id.
 */
export const idToDb =
  (table: TableDef, value: string): Uint8Array | number | string => {
    const kind = idKindOf(table)
    if (kind === 'uuid') return uuidToBuffer(value)
    if (kind === 'integer') return Number(value)
    return value
  }

/**
 * The string id of a value read from the table's key column.
 *
 * @param table - The table.
 * @param value - The stored key.
 */
export const idFromDb =
  (table: TableDef, value: unknown): string =>
    idKindOf(table) === 'uuid' ? canonicalUuid(value) : String(value)

/**
 * SQL for a base-table row's id as views show it, for comparing with a view's `id` column.
 *
 * @param table - The table.
 * @param alias - The table's alias in the query.
 * @param column - The key column, or a foreign key that references it.
 */
export const idSql =
  (table: TableDef, alias: string, column = table.idColumn): string =>
    idKindOf(table) === 'uuid' ? uuidString(reference(alias, column)) : reference(alias, column)

/**
 * A condition matching a row by its id, for the `sql.ts` helpers.
 *
 * @param table - The table.
 * @param value - A valid id.
 */
export const keyCondition =
  (table: TableDef, value: string): Record<string, unknown> => ({ [table.idColumn]: idToDb(table, value) })

/**
 * The stored key to look a row up by, or `null` when the id cannot be one of
 * the table's ids, so the lookup finds nothing rather than failing.
 *
 * @param table - The table.
 * @param value - An id from a URL, a document or an embedded row.
 */
export const keyParam =
  (table: TableDef, value: string): Uint8Array | number | string | null =>
    isValidId(table, value) ? idToDb(table, value) : null
