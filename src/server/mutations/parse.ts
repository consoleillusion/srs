import { badRequest } from '../errors.ts'
import { isObject } from '../guard.ts'
import { ajv, errorField } from '../ajv.ts'
import type { ResourceMeta, RelationshipMeta } from '../registry.ts'
import { canonicalId, idKindOf, isValidId } from '../ids.ts'
import { type WriteDocument, type AttributeValidator } from './types.ts'

const attributeValidators =
  new WeakMap<ResourceMeta, AttributeValidator>()

const buildAttributeValidator =
  (resource: ResourceMeta): AttributeValidator => {
    const cached = attributeValidators.get(resource)
    if (cached) return cached

    // Compile the column schemas themselves so every keyword the author wrote
    // (pattern, minimum, nested properties, items, ...) is enforced. Required
    // attributes stay mode-aware: create/put check them in the write path,
    // while patch may omit them.
    const writable = new Set(writableAttributes(resource))
    const properties =
      Object.fromEntries(
        resource.definition.columns
          .filter(column => writable.has(column.columnName))
          .map(column => [column.columnName, column.schema]))

    const validator =
      ajv.compile(
        { type: 'object'
        , additionalProperties: false
        , properties
        })

    attributeValidators.set(resource, validator)
    return validator
  }

const identifier =
  ( value: unknown
  , label: string
  , meta: RelationshipMeta) => {
    if (!isObject(value)
        || value.type !== meta.type
        || typeof value.id !== 'string'
        || !isValidId(meta.target, value.id))
      throw badRequest(
        `Relationship "${label}" must contain "${meta.type}" identifiers`
        , `relationships.${label}`)

    return canonicalId(meta.target, value.id)
  }

export const parseRelationship =
  ( label: string
  , value: unknown
  , meta: RelationshipMeta): string | null | string[] => {
    if (!isObject(value) || !Object.hasOwn(value, 'data'))
      throw badRequest(
        `Relationship "${label}" must contain "data"`, `relationships.${label}`)

    if (meta.cardinality === 'one')
      return value.data === null
        ? null
        : identifier(value.data, label, meta)

    if (!Array.isArray(value.data))
      throw badRequest(
        `Relationship "${label}" must contain an array of identifiers`
        , `relationships.${label}`)

    return [...new Set(value.data.map(x => identifier(x, label, meta)))]
  }

export const parseWriteDocument =
  ( resource: ResourceMeta
  , body: unknown
  , options: { id?: string } = {}): WriteDocument => {
    if (!isObject(body) || !isObject(body.data))
      throw badRequest('Request body must contain a JSON:API "data" object')

    const data = body.data
    if (data.type !== resource.type)
      throw badRequest(
        `Resource type must be "${resource.type}"`, 'data.type')

    let id: string | undefined
    if (data.id !== undefined) {
      const table = resource.definition
      if (typeof data.id !== 'string' || !isValidId(table, data.id))
        throw badRequest(
          { uuid: 'Resource id must be a canonical UUID'
          , integer: 'Resource id must be a whole number, as a string'
          , string: 'Resource id must be a string of 1 to 255 characters'
          }[idKindOf(table)]
          , 'data.id')
      id = canonicalId(table, data.id)
    }

    if (options.id !== undefined
        && id !== undefined
        && id !== canonicalId(resource.definition, options.id))
      throw badRequest(
        'Resource id does not match the request path', 'data.id')

    const rawAttributes = data.attributes ?? {}
    if (!isObject(rawAttributes))
      throw badRequest('Attributes must be an object', 'data.attributes')

    const writable = new Set(writableAttributes(resource))
    const attributes: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(rawAttributes)) {
      if (!writable.has(name))
        throw badRequest(
          resource.attributes.includes(name)
            ? `Attribute "${name}" is read-only`
            : `Unknown attribute "${name}" for resource "${resource.type}"`
          , `data.attributes.${name}`)
      attributes[name] = value
    }

    const validateAttributes = buildAttributeValidator(resource)
    if (!validateAttributes(attributes)) {
      const field = errorField(validateAttributes, 'data.attributes')
      throw badRequest(
        `Attribute "${field}" is invalid`
        , `data.attributes.${field}`)
    }

    const rawRelationships = data.relationships ?? {}
    if (!isObject(rawRelationships))
      throw badRequest('Relationships must be an object', 'data.relationships')

    const relationships =
      new Map<string, string | null | string[]>()
    for (const [label, value] of Object.entries(rawRelationships)) {
      const meta = resource.relationships[label]
      if (!meta)
        throw badRequest(
          `Unknown relationship "${label}" for resource "${resource.type}"`
          , `data.relationships.${label}`)
      relationships.set(label, parseRelationship(label, value, meta))
    }

    return (
      { ...(id ? { id } : {})
      , attributes
      , relationships
      })
  }

/** The attributes a client may write: not updated_at and nothing marked readOnly. */
export const writableAttributes =
  (resource: ResourceMeta) => {
    const readOnly =
      new Set(
        resource.definition.columns
          .filter(x => x.schema.readOnly === true)
          .map(x => x.columnName))
    return resource.attributes.filter(x => x !== 'updated_at' && !readOnly.has(x))
  }
