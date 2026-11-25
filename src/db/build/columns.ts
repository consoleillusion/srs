import { snakeCase, storedAsJson, type ColumnSql, type JSONSchemaProperty } from '../schema-types.ts'

const UUID_DEFAULT = '(uuid7())'

const TIMESTAMP_DEFAULT =
  "(cast((julianday('now') - 2440587.5)*86400000 as integer))"

export const createUpdatedTrigger =
  (tableName: string, idColumn = 'id') => `
CREATE TRIGGER IF NOT EXISTS \`${tableName}_updated\`
AFTER UPDATE ON \`${tableName}\`
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE \`${tableName}\`
    SET updated_at = CAST(
      (julianday('now') - 2440587.5) * 86400000 AS INTEGER
    )
    WHERE ${idColumn === 'id' ? 'id = OLD.id' : `\`${idColumn}\` = OLD.\`${idColumn}\``};
END;`.trim()

/**
 * Build the triggers that make a table append-only (`x-append-only: true`):
 * any `UPDATE` or `DELETE` on it fails. See the design book, Access control.
 *
 * @param tableName - The table to protect.
 * @returns Trigger name to `CREATE TRIGGER` statement.
 */
export const createAppendOnlyTriggers =
  (tableName: string): Record<string, string> =>
    Object.fromEntries(
      (['update', 'delete'] as const).map(operation => [
        `${tableName}_no_${operation}`,
        `CREATE TRIGGER IF NOT EXISTS \`${tableName}_no_${operation}\`\n`
        + `BEFORE ${operation.toUpperCase()} ON \`${tableName}\`\n`
        + 'FOR EACH ROW\n'
        + `BEGIN SELECT RAISE(ABORT, '${tableName} is append-only'); END;`,
      ]))

export const validateExposure =
  (title: string, value: unknown, label: string) => {
    if (value !== undefined && typeof value !== 'boolean')
      throw new Error(`${title}: ${label} x-exposed must be a boolean`)
  }

const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`

/** A schema default as a SQL literal, or undefined when it cannot be stored. */
const defaultSql =
  (value: unknown, property: JSONSchemaProperty) => {
    if (storedAsJson(property))
      return quoted(JSON.stringify(value))
    if (property.format === 'date-time') {
      const millis = typeof value === 'string' ? Date.parse(value) : NaN
      return Number.isFinite(millis) ? String(millis) : undefined
    }
    if (property.type === 'boolean') return value ? '1' : '0'
    return typeof value === 'string' ? quoted(value) : String(value)
  }

const typeOf =
  (property: JSONSchemaProperty): ColumnSql['type'] => {
    if (property.format === 'uuid' || property.format === 'byte') return 'blob'
    if (property.format === 'date-time') return 'integer'
    if (property.type === 'integer' || property.type === 'boolean') return 'integer'
    if (property.type === 'number') return 'real'
    return 'text'
  }

/** The SQLite declaration of a column built from a schema property. */
export const buildColumn =
  (key: string, property: JSONSchemaProperty, required: boolean, isKey = snakeCase(key) === 'id'): ColumnSql => {
    const columnName = snakeCase(key)
    const isUpdatedAt = columnName === 'updated_at'
    // A uuid key is generated; an integer key is assigned by SQLite (it is the rowid); a text key comes from the client.
    const fallback =
      isKey && property.format === 'uuid' ? UUID_DEFAULT : isUpdatedAt ? TIMESTAMP_DEFAULT : undefined
    const declared =
      property.default === undefined ? undefined : defaultSql(property.default, property)

    return (
      { type: typeOf(property)
      , notNull: required || isUpdatedAt || (isKey && property.type !== 'integer')
      , unique: property['x-unique'] === true && !isKey
      , primaryKey: isKey
      , ...(declared ?? fallback ? { default: declared ?? fallback } : {})
      })
  }
