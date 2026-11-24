/**
 * The meta-schema of every keyword SRS understands (design book, Schema
 * reference). Each schema file is checked against it before anything is
 * generated, so a misspelt keyword fails loudly with its file and JSON pointer
 * instead of being silently ignored.
 *
 * @module
 */
import Ajv, { type ErrorObject } from 'ajv'

const OPERATIONS = ['read', 'create', 'update', 'delete']
const VISIBILITIES = ['private', 'authenticated', 'public', 'shared']
const FK_ACTIONS = ['cascade', 'restrict', 'no action', 'set null', 'set default']

/** Operations, as `true` (all, or every write for `signed`) or a list. */
const operations = { anyOf: [{ type: 'boolean' }, { type: 'array', items: { enum: OPERATIONS }, uniqueItems: true }] }

/** Standard JSON Schema keywords that SRS accepts, at the schema or property level. */
const standard =
  { $schema: { type: 'string' }
  , $id: { type: 'string' }
  , $comment: { type: 'string' }
  , $defs: { type: 'object' }
  , definitions: { type: 'object' }
  , title: { type: 'string' }
  , description: { type: 'string' }
  , examples: { type: 'array' }
  , deprecated: { type: 'boolean' }
  , default: true
  , const: true
  , enum: { type: 'array', minItems: 1 }
  , readOnly: { type: 'boolean' }
  , writeOnly: { type: 'boolean' }
  , format: { type: 'string' }
  , pattern: { type: 'string' }
  , minLength: { type: 'integer', minimum: 0 }
  , maxLength: { type: 'integer', minimum: 0 }
  , minimum: { type: 'number' }
  , maximum: { type: 'number' }
  , exclusiveMinimum: { type: 'number' }
  , exclusiveMaximum: { type: 'number' }
  , multipleOf: { type: 'number', exclusiveMinimum: 0 }
  , minItems: { type: 'integer', minimum: 0 }
  , maxItems: { type: 'integer', minimum: 0 }
  , uniqueItems: { type: 'boolean' }
  , minProperties: { type: 'integer', minimum: 0 }
  , maxProperties: { type: 'integer', minimum: 0 }
  , required: { type: 'array', items: { type: 'string' }, uniqueItems: true }
  , additionalProperties: { anyOf: [{ type: 'boolean' }, { $ref: '#/$defs/property' }] }
  , anyOf: { type: 'array', items: { $ref: '#/$defs/property' } }
  , oneOf: { type: 'array', items: { $ref: '#/$defs/property' } }
  , allOf: { type: 'array', items: { $ref: '#/$defs/property' } }
  , not: { $ref: '#/$defs/property' }
  , type:
      { anyOf:
          [ { enum: ['string', 'integer', 'number', 'boolean', 'object', 'array', 'null'] }
          , { type: 'array', items: { enum: ['string', 'integer', 'number', 'boolean', 'object', 'array', 'null'] } }
          ] }
  }

/** The meta-schema itself. */
export const META_SCHEMA =
  { $schema: 'http://json-schema.org/draft-07/schema#'
  , $defs:
      { property:
          { type: 'object'
          , additionalProperties: false
          , properties:
              { ...standard
              , properties: { type: 'object', additionalProperties: { $ref: '#/$defs/property' } }
              , items: { $ref: '#/$defs/property' }
              , 'x-unique': { type: 'boolean' }
              , 'x-primary': { type: 'boolean' }
              , 'x-exposed': { type: 'boolean' }
              , 'x-source': { type: 'string', minLength: 1 }
              }
          }
      , relation:
          { type: 'object'
          , additionalProperties: false
          , required: ['table', 'cardinality']
          , properties:
              { table: { type: 'string', minLength: 1 }
              , column: { type: 'string', minLength: 1 }
              , cardinality: { enum: ['one', 'many'] }
              , foreignKey: { type: 'string', minLength: 1 }
              , through: { type: 'string', minLength: 1 }
              , required: { type: 'boolean' }
              , onDelete: { enum: FK_ACTIONS }
              , onUpdate: { enum: FK_ACTIONS }
              , 'x-exposed': { type: 'boolean' }
              , 'x-link-any': { type: 'boolean' }
              }
          }
      , access:
          { type: 'object'
          , additionalProperties: false
          , properties:
              { read: { enum: ['session', 'public'] }
              , create: { enum: ['session', 'public', 'role', 'none'] }
              , visibility: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: VISIBILITIES } }
              , defaultVisibility: { enum: VISIBILITIES }
              , shareable: { type: 'boolean' }
              , signed: operations
              , roles: { type: 'object', additionalProperties: operations }
              , inherit: { type: 'string', minLength: 1 }
              , audited: operations
              }
          }
      }
  , type: 'object'
  , additionalProperties: false
  , required: ['title']
  , properties:
      { ...standard
      , title: { type: 'string', minLength: 1 }
      , properties: { type: 'object', additionalProperties: { $ref: '#/$defs/property' } }
      , 'x-system': { type: 'boolean' }
      , 'x-view': { type: 'boolean' }
      , 'x-source': { type: 'string', minLength: 1 }
      , 'x-exposed': { type: 'boolean' }
      , 'x-append-only': { type: 'boolean' }
      , 'x-access': { $ref: '#/$defs/access' }
      , 'x-relations': { type: 'object', additionalProperties: { $ref: '#/$defs/relation' } }
      , 'x-unique-constraints':
          { type: 'array', items: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } } }
      , 'x-checks': { type: 'array', items: { type: 'string', minLength: 1 } }
      }
  } as const

const ajv = new Ajv({ allErrors: true, strict: false })
const validate = ajv.compile(META_SCHEMA)

/** Describe one meta-schema error, naming the offending keyword where possible. */
const describe =
  (error: ErrorObject): string => {
    const pointer = error.instancePath || '/'
    if (error.keyword === 'additionalProperties') {
      const keyword = String((error.params as { additionalProperty?: string }).additionalProperty)
      const at = `${error.instancePath}/${keyword}`
      return keyword.startsWith('x-')
        ? `${at}: unknown SRS keyword "${keyword}"`
        : `${at}: unsupported keyword "${keyword}"`
    }
    if (error.keyword === 'enum')
      return `${pointer}: must be one of ${((error.params as { allowedValues?: unknown[] }).allowedValues ?? []).map(x => JSON.stringify(x)).join(', ')}`
    return `${pointer}: ${error.message ?? 'is invalid'}`
  }

/**
 * Check one schema against the meta-schema.
 *
 * @param schema - The schema, after `$ref` resolution.
 * @returns One message per problem, each starting with a JSON pointer; empty when valid.
 */
export const checkSchema =
  (schema: unknown): string[] => {
    if (validate(schema)) return []
    // anyOf failures repeat their branches' errors; keep the clearest message per path.
    const seen = new Set<string>()
    return (validate.errors ?? [])
      .filter(x => x.keyword !== 'anyOf' && x.keyword !== 'if')
      .map(describe)
      .filter(x => !seen.has(x) && seen.add(x) !== undefined)
  }
