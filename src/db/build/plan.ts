import { DERIVED_SOURCE, keyColumnOf } from '../derive/helpers.ts'
import { pascalCase, snakeCase, type ColumnDef, type ForeignKeyDef, type JSONSchemaProperty, type LoadedSchema, type TableDef } from '../schema-types.ts'
import { normalizeAccess } from '../access.ts'
import { createAppendOnlyTriggers, createUpdatedTrigger, validateExposure, buildColumn } from './columns.ts'
import { validateRelation, foreignKeyColumnOf, buildUniqueConstraints } from './relations.ts'


const SYSTEM_SCHEMA_DIR = 'src/schema/system/'

export type TablePlan = Omit<TableDef, 'createSql' | 'indexSql'>

export const buildTablePlan =
  (loaded: LoadedSchema): TablePlan => {
    const schema = loaded.schema
    const declared = Object.entries(schema.properties ?? {})

    const access = normalizeAccess(schema)
    // A property marked x-primary replaces the generated uuid id (design book, Schema).
    const idColumn = keyColumnOf(schema)

    const systemColumns: [string, JSONSchemaProperty][] =
      [ ...(idColumn === 'id' ? [['id', { type: 'string', format: 'uuid', 'x-primary': true }] as [string, JSONSchemaProperty]] : [])
      , ['updated_at', { type: 'string', format: 'date-time' }]
      , [ 'owner'
        , { type: 'string', format: 'uuid', description: 'Owner user id' }
        ]
      , ...(schema['x-exposed'] === false
          ? []
          : [ [ 'visibility'
              , { type: 'string'
                , enum: access.visibility
                , default: access.defaultVisibility
                , description: 'Who can read the row; only the owner can write it'
                }
              ] as [string, JSONSchemaProperty]
            ])
      ]
    const isSystemKey =
      (key: string) => systemColumns.some(([name]) => snakeCase(key) === name)

    // System columns come first, taken from the schema when it declares them.
    const keyEntry = idColumn === 'id' ? [] : declared.filter(([key]) => snakeCase(key) === idColumn)
    const orderedEntries =
      [ ...keyEntry
      , ...systemColumns.map(
          ([name, fallback]) =>
            declared.find(([key]) => snakeCase(key) === name) ?? [name, fallback])
      , ...declared.filter(([key]) => !isSystemKey(key) && snakeCase(key) !== idColumn)
      ] as [string, JSONSchemaProperty][]
    const injected =
      new Set(
        systemColumns
          .map(([name]) => name)
          .filter(name => !declared.some(([key]) => snakeCase(key) === name)))

    validateExposure(schema.title, schema['x-exposed'], 'table')

    const requiredNames = new Set((schema.required ?? []).map(snakeCase))
    const columns: ColumnDef[] =
      orderedEntries.map(([key, property]) => {
        const columnName = snakeCase(key)
        validateExposure(schema.title, property['x-exposed'], `property "${key}"`)
        const isRequired =
          requiredNames.has(columnName)
          || (columnName === idColumn && property.type !== 'integer')
          || columnName === 'updated_at'
          || columnName === 'visibility'
        return (
          { key
          , columnName
          , schema: property
          , sql: buildColumn(key, property, isRequired, columnName === idColumn)
          , required: isRequired
          , injected: injected.has(columnName)
          , exposed: property['x-exposed'] !== false
          })
      })

    const columnNames = new Set<string>()
    for (const column of columns) {
      if (columnNames.has(column.columnName))
        throw new Error(`${schema.title}: duplicate column "${column.columnName}"`)
      columnNames.add(column.columnName)
    }

    if (idColumn !== 'id' && columnNames.has('id'))
      throw new Error(
        `${schema.title}: "${idColumn}" is the x-primary key, so there cannot also be a column "id"`)

    const relations = schema['x-relations'] ?? {}
    for (const [label, relation] of Object.entries(relations)) {
      validateRelation(schema.title, label, relation)
      // An inverse-one many relation rewrites target rows, so allowing targets
      // outside the writer's scope would let them take over another user's row.
      if (relation.cardinality === 'many'
          && !relation.through
          && relation['x-link-any'] === true)
        throw new Error(
          `${schema.title}: relation "${label}" cannot use x-link-any`
          + ' without a through table')
    }

    if (access.inherit && relations[access.inherit]?.cardinality !== 'one')
      throw new Error(
        `${schema.title}: x-access inherit "${access.inherit}" must name a to-one relation`)

    const foreignKeys: ForeignKeyDef[] = []
    for (const [label, relation] of Object.entries(relations)) {
      if (relation.cardinality !== 'one') continue

      const foreignKeyColumn = foreignKeyColumnOf(relation)
      if (!columnNames.has(foreignKeyColumn))
        throw new Error(
          `${schema.title}: relation "${label}" foreign key column "${foreignKeyColumn}" does not exist`)

      foreignKeys.push(
        { columns: [foreignKeyColumn]
        , foreignTable: relation.table
        , foreignColumns: [relation.column ?? 'id']
        , ...(relation.onDelete ? { onDelete: relation.onDelete } : {})
        , ...(relation.onUpdate ? { onUpdate: relation.onUpdate } : {})
        })
    }

    const uniqueConstraints =
      buildUniqueConstraints(schema, columnNames)

    const indexes =
      [...new Set([...foreignKeys.flatMap(x => x.columns), 'owner'])]

    const tableName = snakeCase(schema.title)
    if (schema['x-append-only'] !== undefined
        && typeof schema['x-append-only'] !== 'boolean')
      throw new Error(`${schema.title}: x-append-only must be a boolean`)

    return (
      { key: pascalCase(schema.title)
      , tableName
      , idColumn
      , schema
      , columns
      , isSystem:
          schema['x-system'] === true
          || (loaded.source !== DERIVED_SOURCE
              && loaded.importPath.startsWith(SYSTEM_SCHEMA_DIR))
      , derived: loaded.source === DERIVED_SOURCE
      , exposed: schema['x-exposed'] !== false
      , access
      , relations
      , foreignKeys
      , uniqueConstraints
      , indexes
      , trigger: createUpdatedTrigger(tableName, idColumn)
      , guardTriggers:
          schema['x-append-only'] === true ? createAppendOnlyTriggers(tableName) : {}
      })
  }
