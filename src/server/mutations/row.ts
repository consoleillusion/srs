import type { Row, RowDatabase } from '../database.ts'
import type { ResourceMeta } from '../registry.ts'
import { quoteIdentifier } from '../query.ts'
import { type Scope } from '../scope.ts'
import { keyParam } from '../ids.ts'
import { keySql } from '../rows.ts'

export const readResourceRow =
  (db: RowDatabase, resource: ResourceMeta, id: string, scope: Scope = { sql: '', params: [] }): Promise<Row | undefined> =>
    db.get(
      `${resource.select} WHERE ${keySql(resource, resource.view)} = ?`
      + (scope.sql ? ` AND ${scope.sql}` : '')
      + ' LIMIT 1'
      , [keyParam(resource.definition, id), ...scope.params])
