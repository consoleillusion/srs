import { pascalCase, type JSONSchema, type LoadedSchema } from '../schema-types.ts'
import { DERIVED_SOURCE, keyColumnOf, titleFromTableName, resolveTargetProperty, foreignKeyProperty } from './helpers.ts'

export type JoinCandidate =
  { pair: [string, string]
  , label: string
  , explicitThrough: Set<string>
  }

export const deriveJoinTable =
  ( pair: [string, string]
  , through: string
  , schemas: Map<string, LoadedSchema>
  ): LoadedSchema => {
    const [leftTable, rightTable] = pair
    // A self-referential pair needs distinct names for its two sides
    const selfReferential = leftTable === rightTable
    const rightName = selfReferential ? `related_${rightTable}` : rightTable

    const leftSchema = schemas.get(leftTable)!.schema
    const rightSchema = schemas.get(rightTable)!.schema
    const leftColumn = `${leftTable}_id`
    const rightColumn = `${rightName}_id`
    const leftKey = keyColumnOf(leftSchema)
    const rightKey = keyColumnOf(rightSchema)
    const leftTarget = resolveTargetProperty(leftSchema, leftTable, leftKey)
    const rightTarget = resolveTargetProperty(rightSchema, rightTable, rightKey)

    const schema: JSONSchema =
      { $schema: 'https://json-schema.org/draft/2020-12/schema'
      , title: titleFromTableName(through)
      , type: 'object'
      , additionalProperties: false
      , description: `Join table between ${leftTable} and ${rightTable}`
      , properties:
        { [leftColumn]: foreignKeyProperty(leftTable, leftKey, leftTarget.property)
        , [rightColumn]: foreignKeyProperty(rightTable, rightKey, rightTarget.property)
        }
      , required: [leftColumn, rightColumn]
      , 'x-relations':
        { [leftTable]:
          { table: leftTable
          , column: leftKey
          , cardinality: 'one'
          , foreignKey: leftColumn
          , required: true
          }
        , [rightName]:
          { table: rightTable
          , column: rightKey
          , cardinality: 'one'
          , foreignKey: rightColumn
          , required: true
          }
        }
      , 'x-unique-constraints': [[leftColumn, rightColumn]]
      }

    return (
      { schema
      , source: DERIVED_SOURCE
      , importPath: DERIVED_SOURCE
      })
  }
