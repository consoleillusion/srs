/**
 * `import`: give an existing SQLite database an SRS API (design book, Existing
 * databases). {@link planImport} reads the source's tables, keys and foreign
 * keys and turns each table into a schema; {@link copyRows} copies the rows
 * into an SRS database built from those schemas. The source is only read.
 *
 * @module
 */
import { Database as SourceDatabase } from 'bun:sqlite'
import { snakeCase, type JSONSchema, type JSONSchemaProperty, type TableDef } from './schema-types.ts'
import { titleFromTableName } from './derive/helpers.ts'
import { insert } from '../server/sql.ts'
import type { RowDatabase } from '../server/database.ts'
import { uuidToBuffer } from '../server/uuid.ts'

/** Tables SRS always has; an imported table with one of these names is renamed. */
export const SYSTEM_TABLES =
  [ 'audit_log', 'auth_limit', 'key', 'request_nonce', 'schema', 'user', 'user_group'
  , 'user_group_membership', 'user_role' ]

/** Columns SRS adds to every table; an imported column with one of these names is renamed. */
const SYSTEM_COLUMNS = ['owner', 'visibility', 'updated_at']

/** One source column as SQLite describes it. */
type SourceColumn = { cid: number, name: string, type: string, notnull: number, dflt_value: string | null, pk: number }

/** One foreign key column as SQLite describes it. */
type SourceForeignKey = { id: number, seq: number, table: string, from: string, to: string | null, on_update: string, on_delete: string }

/** How a source column becomes a schema property and how its values are converted. */
export type ColumnPlan =
  { source: string
  , target: string
  , property: JSONSchemaProperty
  , convert: 'none' | 'boolean' | 'date-time'
  }

/** How a source table becomes a schema. */
export type TablePlan =
  { source: string
  , target: string
  , schema: JSONSchema
  , columns: ColumnPlan[]
  }

/** The result of reading a source database: one schema per table, and everything that could not be carried over. */
export type ImportPlan =
  { tables: TablePlan[]
  , notes: string[]
  }

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

/** A name SRS can use: snake_case, renamed with `suffix` when it clashes with a reserved name. */
const safeName =
  (name: string, reserved: string[], suffix: string, notes: string[], what: string) => {
    let target = snakeCase(name)
    if (!target) target = `${what}_${Math.abs(hash(name))}`
    if (reserved.includes(target)) {
      notes.push(`${what} "${name}" is named like an SRS ${what}; it is imported as "${target}${suffix}".`)
      target = `${target}${suffix}`
    }
    else if (target !== name) notes.push(`${what} "${name}" is imported as "${target}".`)
    return target
  }

const hash = (value: string) => [...value].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)

/**
 * The schema property for a declared SQLite type, following SQLite's own type
 * affinity rules (https://sqlite.org/datatype3.html, section 3.1), with names
 * that mean booleans and dates mapped to SRS's boolean and date-time.
 */
const propertyFor =
  (column: SourceColumn, table: string, notes: string[]): Pick<ColumnPlan, 'property' | 'convert'> => {
    const type = column.type.toUpperCase()
    const length = type.match(/\(\s*(\d+)\s*\)/)?.[1]
    if (/BOOL/.test(type)) return { property: { type: 'boolean' }, convert: 'boolean' }
    if (/DATE|TIME/.test(type)) {
      notes.push(`${table}.${column.name} (${column.type}) becomes a date-time; values are converted to SRS timestamps, and text that is not a date stops the copy.`)
      return { property: { type: 'string', format: 'date-time' }, convert: 'date-time' }
    }
    if (type.includes('INT')) return { property: { type: 'integer' }, convert: 'none' }
    if (/CHAR|CLOB|TEXT/.test(type))
      return { property: { type: 'string', ...(length ? { maxLength: Number(length) } : {}) }, convert: 'none' }
    if (type === '' || type.includes('BLOB')) {
      notes.push(`${table}.${column.name} has no type or is a BLOB; it is imported as bytes (hex in JSON).`)
      return { property: { type: 'string', format: 'byte' }, convert: 'none' }
    }
    if (/REAL|FLOA|DOUB/.test(type)) return { property: { type: 'number' }, convert: 'none' }
    notes.push(`${table}.${column.name} (${column.type}) becomes a number; exact decimals may lose precision.`)
    return { property: { type: 'number' }, convert: 'none' }
  }

/** A literal SQLite default as a schema default, or undefined when it is an expression. */
const defaultOf =
  (value: string | null, property: JSONSchemaProperty) => {
    if (value === null) return undefined
    const text = value.match(/^'(.*)'$/s)?.[1]?.replaceAll("''", "'")
    if (text !== undefined) return property.type === 'string' && property.format === undefined ? text : undefined
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      if (property.type === 'boolean') return value !== '0'
      return property.type === 'integer' || property.type === 'number' ? Number(value) : undefined
    }
    if (/^(TRUE|FALSE)$/i.test(value) && property.type === 'boolean') return value.toUpperCase() === 'TRUE'
    return undefined
  }

const ON_DELETE: Record<string, NonNullable<import('./schema-types.ts').RelationConfig['onDelete']>> =
  { CASCADE: 'cascade', RESTRICT: 'restrict', 'SET NULL': 'set null', 'SET DEFAULT': 'set default' }

/**
 * Read a SQLite database and plan one schema per table. Nothing is written.
 *
 * @param file - The source database; opened read-only.
 * @returns The schemas, how to copy each table, and notes on what was not carried over.
 */
export const planImport =
  (file: string): ImportPlan => {
    const source = new SourceDatabase(file, { readonly: true })
    try {
      const notes: string[] = []
      const names =
        (source.query("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string, sql: string }[])
      for (const other of source.query("SELECT type, name FROM sqlite_master WHERE type IN ('view', 'trigger') ORDER BY name").all() as { type: string, name: string }[])
        notes.push(`The ${other.type} "${other.name}" is not imported.`)

      const tableNames = new Map(names.map(x => [x.name, safeName(x.name, SYSTEM_TABLES, '_imported', notes, 'table')]))
      const columnsOf = (table: string) => source.query(`PRAGMA table_info(${quote(table)})`).all() as SourceColumn[]
      const keyOf =
        (table: string) => {
          const pk = columnsOf(table).filter(x => x.pk > 0)
          return pk.length === 1 ? pk[0]!.name : undefined
        }

      const tables: TablePlan[] = []
      for (const { name, sql } of names) {
        const target = tableNames.get(name)!
        if (/\bWITHOUT\s+ROWID\b/i.test(sql ?? '')) notes.push(`${name} is a WITHOUT ROWID table; it is imported as an ordinary table.`)
        if (/\bCHECK\s*\(/i.test(sql ?? '')) notes.push(`${name} has CHECK constraints; they are not imported.`)

        const sourceColumns = columnsOf(name)
        const pk = sourceColumns.filter(x => x.pk > 0)
        const columns: ColumnPlan[] = []
        const properties: Record<string, JSONSchemaProperty> = {}
        const required: string[] = []

        for (const column of sourceColumns) {
          const reserved = pk.length === 1 && column.pk > 0 ? SYSTEM_COLUMNS : [...SYSTEM_COLUMNS, 'id']
          const columnName = safeName(column.name, reserved, '_source', notes, 'column')
          const { property, convert } = propertyFor(column, name, notes)
          const fallback = defaultOf(column.dflt_value, property)
          if (column.dflt_value !== null && fallback === undefined)
            notes.push(`${name}.${column.name} has the default ${column.dflt_value}, which is not imported.`)
          if (fallback !== undefined) property.default = fallback

          const isKey = pk.length === 1 && column.pk > 0
          if (isKey) {
            if (property.type === 'integer' || (property.type === 'string' && property.format === undefined)) {
              property['x-primary'] = true
            }
            else notes.push(`${name}.${column.name} is the primary key but is not an integer or text; rows get a new uuid id and it is kept as a unique column.`)
          }
          if (isKey && !property['x-primary']) property['x-unique'] = true
          // Columns that together identify a row cannot be empty.
          if ((column.notnull || (pk.length > 1 && column.pk > 0)) && !isKey) required.push(columnName)
          properties[columnName] = property
          columns.push({ source: column.name, target: columnName, property, convert })
        }
        if (pk.length > 1)
          notes.push(`${name} has a composite primary key (${pk.map(x => x.name).join(', ')}); rows get a new uuid id and the columns are kept unique together.`)
        if (pk.length === 0)
          notes.push(`${name} has no primary key; rows get a new uuid id.`)

        // Single-column UNIQUE constraints and unique indexes.
        const unique: string[][] = pk.length > 1 ? [pk.map(x => columns.find(c => c.source === x.name)!.target)] : []
        for (const index of source.query(`PRAGMA index_list(${quote(name)})`).all() as { name: string, unique: number, origin: string }[]) {
          if (!index.unique || index.origin === 'pk') continue
          const parts = (source.query(`PRAGMA index_info(${quote(index.name)})`).all() as { name: string | null }[]).map(x => x.name)
          if (parts.some(x => x === null)) { notes.push(`The unique index ${index.name} on ${name} uses an expression; it is not imported.`); continue }
          const targets = parts.map(x => columns.find(c => c.source === x)!.target)
          if (targets.length === 1) properties[targets[0]!]!['x-unique'] = true
          else unique.push(targets)
        }
        for (const index of source.query(`PRAGMA index_list(${quote(name)})`).all() as { name: string, unique: number, origin: string }[])
          if (!index.unique && index.origin === 'c') notes.push(`The index ${index.name} on ${name} is not imported; SRS indexes foreign keys and owners itself.`)

        // Foreign keys: single-column ones that reference the target's key become relations.
        const relations: NonNullable<JSONSchema['x-relations']> = {}
        const foreignKeys = source.query(`PRAGMA foreign_key_list(${quote(name)})`).all() as SourceForeignKey[]
        for (const id of [...new Set(foreignKeys.map(x => x.id))]) {
          const parts = foreignKeys.filter(x => x.id === id)
          const first = parts[0]!
          const targetKey = keyOf(first.table)
          const to = first.to ?? targetKey
          const label = `${name}.${parts.map(x => x.from).join(', ')}`
          if (parts.length > 1) { notes.push(`The foreign key ${label} → ${first.table} has several columns; it is kept as plain columns.`); continue }
          if (!tableNames.has(first.table)) { notes.push(`The foreign key ${label} → ${first.table} targets a missing table; it is kept as a plain column.`); continue }
          if (to !== targetKey) { notes.push(`The foreign key ${label} → ${first.table}.${to} does not reference that table's primary key; it is kept as a plain column.`); continue }
          const targetTable = tableNames.get(first.table)!
          const fromColumn = columns.find(c => c.source === first.from)!
          const targetPlan = columnsOf(first.table).find(x => x.name === to)!
          const targetProperty = propertyFor(targetPlan, first.table, []).property
          if (targetProperty.type !== 'integer' && !(targetProperty.type === 'string' && targetProperty.format === undefined)) {
            notes.push(`The foreign key ${label} → ${first.table} targets a key SRS cannot use; it is kept as a plain column.`)
            continue
          }
          let relation = targetTable
          if (relations[relation] || properties[relation]) relation = `${fromColumn.target}_${targetTable}`
          // The foreign key column's type comes from the target's key, so it is not declared twice.
          fromColumn.property = { ...targetProperty, ...(fromColumn.property.default !== undefined ? { default: fromColumn.property.default } : {}) }
          properties[fromColumn.target] = fromColumn.property
          relations[relation] =
            { table: targetTable
            , cardinality: 'one'
            , foreignKey: fromColumn.target
            , ...(ON_DELETE[first.on_delete.toUpperCase()] ? { onDelete: ON_DELETE[first.on_delete.toUpperCase()] } : {})
            }
        }

        const title = titleFromTableName(target)
        if (snakeCase(title) !== target) notes.push(`${name}: the table name "${target}" may not survive as a title; check the schema.`)
        const schema: JSONSchema =
          { $schema: 'https://json-schema.org/draft/2020-12/schema'
          , title
          , type: 'object'
          , additionalProperties: false
          , description: `Imported from the table "${name}". Rows are private to their owner until x-access says otherwise.`
          , properties
          , ...(required.length ? { required } : {})
          , ...(Object.keys(relations).length ? { 'x-relations': relations } : {})
          , ...(unique.length ? { 'x-unique-constraints': unique } : {})
          }
        tables.push({ source: name, target, schema, columns })
      }
      return { tables, notes }
    } finally {
      source.close()
    }
  }

/** Convert one source value for its column. */
const convertValue =
  (column: ColumnPlan, value: unknown, where: string) => {
    if (value === null || value === undefined) return null
    if (column.convert === 'boolean') return value ? 1 : 0
    if (column.convert === 'date-time') {
      if (typeof value === 'number') return Math.trunc(value > 1e11 ? value : value * 1000)
      // SQLite writes dates without a zone (CURRENT_TIMESTAMP is UTC), so a date without one is read as UTC.
      const text = String(value).trim().replace(' ', 'T')
      const millis = Date.parse(/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text) ? `${text}Z` : text)
      if (!Number.isFinite(millis)) throw new Error(`${where}: "${String(value)}" is not a date`)
      return millis
    }
    if (column.property.format === 'byte' && typeof value === 'string') return new TextEncoder().encode(value)
    return value
  }

/**
 * Copy every row of the source into an SRS database built from the planned
 * schemas, in one transaction. Keys and foreign keys keep their values; every
 * row is owned by `owner`. Refuses when any target table already has rows.
 *
 * @param file - The source database; opened read-only.
 * @param plan - The plan the schemas were written from.
 * @param db - The SRS database, migrated.
 * @param tables - The SRS tables, from the built schemas.
 * @param owner - The owning user's id.
 * @returns Rows copied per table.
 */
export const copyRows =
  async (file: string, plan: ImportPlan, db: RowDatabase, tables: TableDef[], owner: string) => {
    const byName = new Map(tables.map(x => [x.tableName, x]))
    // Referenced tables first, so every foreign key finds its row.
    const order: string[] = []
    const visit =
      (name: string, path: string[]) => {
        if (order.includes(name) || path.includes(name)) return
        for (const key of byName.get(name)?.foreignKeys ?? [])
          if (key.foreignTable !== name) visit(key.foreignTable, [...path, name])
        order.push(name)
      }
    for (const table of plan.tables) visit(table.target, [])
    const planned = plan.tables.filter(x => byName.has(x.target)).sort((a, b) => order.indexOf(a.target) - order.indexOf(b.target))
    const missing = plan.tables.filter(x => !byName.has(x.target)).map(x => x.target)
    if (missing.length > 0)
      throw new Error(`These tables are not in the schemas: ${missing.join(', ')}. Run import without --data again, then init, or remove them from the source.`)
    for (const table of planned) {
      const existing = await db.get(`SELECT count(*) AS n FROM ${quote(table.target)}`)
      if (Number(existing?.n) > 0) throw new Error(`${table.target} already has rows; import copies into empty tables only.`)
    }

    const source = new SourceDatabase(file, { readonly: true })
    const ownerId = uuidToBuffer(owner)
    const counts: Record<string, number> = {}
    try {
      const work =
        async (tx: RowDatabase) => {
          for (const table of planned) {
            const definition = byName.get(table.target)!
            const columns = table.columns.filter(x => definition.columns.some(c => c.columnName === x.target))
            let count = 0
            for (const row of source.query(`SELECT * FROM ${quote(table.source)}`).iterate() as Iterable<Record<string, unknown>>) {
              const values: Record<string, unknown> = { owner: ownerId }
              for (const column of columns)
                values[column.target] = convertValue(column, row[column.source], `${table.source}.${column.source}`)
              await insert(tx, table.target, values, definition.idColumn)
              count++
            }
            counts[table.target] = count
            await insert(tx, 'audit_log', { actor: ownerId, action: 'import', resource: table.target, resource_id: null })
          }
        }
      if (db.transaction) await db.transaction(work)
      else await work(db)
    } finally {
      source.close()
    }
    return counts
  }
