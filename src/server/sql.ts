import { quote } from '../db/views.ts'
import type { Row, RowDatabase, RunResult } from './database.ts'
import { newUuid, uuidToBuffer } from './uuid.ts'

export type Values = Record<string, unknown>

/** Render `col = ? AND ...` for the given column/value pairs. */
const where =
  (conditions: Values) =>
    Object.keys(conditions).map(x => `${quote(x)} = ?`).join(' AND ')

/** Report whether any row in the table matches all the conditions. */
export const exists =
  async (db: RowDatabase, table: string, conditions: Values) => {
    const row =
      await db.get(
        `SELECT 1 AS found FROM ${quote(table)} WHERE ${where(conditions)} LIMIT 1`
        , Object.values(conditions))
    return row !== undefined
  }

/**
 * Insert one row and return its key column (`id` unless the table declares
 * another).
 *
 * When the key is a uuid and the values don't name it, the id is made here,
 * as a UUIDv7 in the 16-byte form SRS stores. The column's `uuid7()` default
 * is never relied on: the embedded engine's returns those 16 bytes, but
 * Turso Cloud's returns text, and a text id can't be found by the 16-byte key
 * SRS looks rows up with.
 *
 * @param db - Where to insert.
 * @param table - The table.
 * @param values - Column values.
 * @param key - The key column.
 * @param uuidKey - Whether the key is a uuid; the system tables' `id` always is.
 */
export const insert =
  (db: RowDatabase, table: string, values: Values, key = 'id', uuidKey = key === 'id'): Promise<Row | undefined> => {
    const row = uuidKey && values[key] === undefined ? { [key]: uuidToBuffer(newUuid()), ...values } : values
    const columns = Object.keys(row)
    const sql =
      columns.length === 0
        ? 'DEFAULT VALUES'
        : `(${columns.map(quote).join(', ')})`
          + ` VALUES (${columns.map(() => '?').join(', ')})`
    return db.get(
      `INSERT INTO ${quote(table)} ${sql} RETURNING ${quote(key)}`, Object.values(row))
  }

/** Set the given columns on every row matching the conditions. */
export const update =
  (db: RowDatabase, table: string, set: Values, conditions: Values): Promise<RunResult> => {
    const assignments = Object.keys(set).map(x => `${quote(x)} = ?`).join(', ')
    return db.run(
      `UPDATE ${quote(table)} SET ${assignments} WHERE ${where(conditions)}`
      , [...Object.values(set), ...Object.values(conditions)])
  }

/** Delete every row matching the conditions. */
export const remove =
  (db: RowDatabase, table: string, conditions: Values): Promise<RunResult> => {
    return db.run(
      `DELETE FROM ${quote(table)} WHERE ${where(conditions)}`
      , Object.values(conditions))
  }
