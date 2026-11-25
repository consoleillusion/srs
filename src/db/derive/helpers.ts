import { snakeCase, type JSONSchema, type JSONSchemaProperty, type RelationConfig } from '../schema-types.ts'


export const DERIVED_SOURCE = '[derived]'

export const DEFAULT_ID = 'id'

const DEFAULT_UPDATED_AT = 'updated_at'

/**
 * The column that identifies a table's rows: the property marked
 * `x-primary: true`, or `id` when there is none (design book, Schema).
 *
 * @param schema - A table schema.
 * @returns The snake_case column name.
 * @throws When more than one property is marked, or the key's type cannot be a resource id.
 */
export const keyColumnOf =
  (schema: JSONSchema): string => {
    const marked =
      Object.entries(schema.properties ?? {}).filter(([, property]) => property['x-primary'] === true)
    if (marked.length > 1)
      throw new Error(`${schema.title}: only one property can be x-primary, found ${marked.map(([key]) => key).join(', ')}`)
    const found = marked[0]
    if (!found) return DEFAULT_ID
    const [key, property] = found
    const type = Array.isArray(property.type) ? property.type.find(x => x !== 'null') : property.type
    if (type !== 'integer' && type !== 'string')
      throw new Error(`${schema.title}: x-primary property "${key}" must be an integer or a string`)
    if (type === 'string' && property.format !== undefined && property.format !== 'uuid')
      throw new Error(`${schema.title}: x-primary property "${key}" cannot have format "${property.format}"`)
    return snakeCase(key)
  }

export const tableNameOf =
  (schema: JSONSchema) => snakeCase(schema.title)

export const titleFromTableName =
  (tableName: string) =>
    tableName
      .split('_')
      .filter(Boolean)
      .map(x => x[0]!.toUpperCase() + x.slice(1))
      .join(' ')

const defaultColumnProperty =
  (columnName: string): JSONSchemaProperty => {
    if (columnName === DEFAULT_ID)
      return { type: 'string', format: 'uuid' }
    if (columnName === DEFAULT_UPDATED_AT)
      return { type: 'string', format: 'date-time' }
    throw new Error(`Unknown default column "${columnName}"`)
  }

export const findProperty =
  (schema: JSONSchema, columnName: string) => {
    const normalized = snakeCase(columnName)
    return Object.entries(schema.properties ?? {})
      .find(([key]) => snakeCase(key) === normalized)
  }

export const resolveTargetProperty =
  (targetSchema: JSONSchema, targetTable: string, columnName: string) => {
    const normalized = snakeCase(columnName)
    const found = findProperty(targetSchema, normalized)
    if (found) return { key: found[0], property: found[1] }
    if (normalized === DEFAULT_ID || normalized === DEFAULT_UPDATED_AT)
      return { key: normalized, property: defaultColumnProperty(normalized) }
    throw new Error(
      `${targetSchema.title}: relation target column "${targetTable}.${normalized}" does not exist`)
  }

export const foreignKeyProperty =
  (targetTable: string, targetColumn: string, target: JSONSchemaProperty): JSONSchemaProperty => (
    { description: `Foreign key to ${targetTable}.${targetColumn}`
    , type: target.type ?? 'string'
    , ...(target.format ? { format: target.format } : {})
    , ...(target.enum ? { enum: target.enum } : {})
    })

const optionalRelationFields: [string, string][] =
  [ ['column', 'string']
  , ['foreignKey', 'string']
  , ['through', 'string']
  , ['required', 'boolean']
  , ['x-exposed', 'boolean']
  ]

/** Reject relation configs whose fields have the wrong shape. */
export const validateRelation =
  (sourceTitle: string, label: string, relation: RelationConfig) => {
    const fail = (message: string): never => {
      throw new Error(`${sourceTitle}: relation "${label}" ${message}`)
    }
    if (!relation || typeof relation !== 'object') fail('must be an object')
    if (typeof relation.table !== 'string' || relation.table.length === 0)
      fail('needs a table')
    if (relation.cardinality !== 'one' && relation.cardinality !== 'many')
      fail('cardinality must be "one" or "many"')
    for (const [field, type] of optionalRelationFields) {
      const value = (relation as Record<string, unknown>)[field]
      if (value !== undefined && typeof value !== type)
        fail(`${field} must be a ${type}`)
    }
  }

export const hasInverseOne =
  (targetSchema: JSONSchema, sourceTable: string) =>
    Object.values(targetSchema['x-relations'] ?? {})
      .some(x => x.cardinality === 'one' && x.table === sourceTable)
