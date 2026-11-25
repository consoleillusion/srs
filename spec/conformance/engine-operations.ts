/**
 * The TypeScript implementation of the schema engine, query compiler and access
 * decision operations (design book, Conformance suites). Each runs the real
 * server code on inline schemas, so another implementation can be checked
 * against the same cases.
 *
 * @module
 */
import { connect } from '@tursodatabase/database'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSchema } from '../../src/db/build-schema.ts'
import { generateMigrations } from '../../src/db/generate-migration.ts'
import { loadSchemas } from '../../src/db/load-schemas.ts'
import { applyMigrations } from '../../src/db/migrate.ts'
import { databaseObjects, planMigration, stateOf } from '../../src/db/migration-plan.ts'
import type { BuiltSchema, JSONSchema } from '../../src/db/schema-types.ts'
import { createRowDatabase, type RowDatabase } from '../../src/server/database.ts'
import { parseListQuery } from '../../src/server/query.ts'
import { listRows } from '../../src/server/read.ts'
import { buildRegistry } from '../../src/server/registry.ts'
import { deleteScope, readScope, writeScope, type Viewer } from '../../src/server/scope.ts'
import { insert } from '../../src/server/sql.ts'
import { keyParam } from '../../src/server/ids.ts'
import { fromSql, keySql } from '../../src/server/rows.ts'
import { uuidToBuffer } from '../../src/server/uuid.ts'
import { bytesToHex } from '../../src/protocol/encoding.ts'
import { ConformanceError, type Operation } from './runner.ts'

/** Build errors, by the stable code a case names. The message is this implementation's own. */
const BUILD_ERRORS: [RegExp, string][] =
  [ [/only one property can be x-primary/, 'several-keys']
  , [/x-primary property "[^"]+" must be an integer or a string/, 'bad-key-type']
  , [/x-primary property "[^"]+" cannot have format/, 'bad-key-format']
  , [/cannot also be a column "id"/, 'key-and-id']
  , [/targets unknown table/, 'unknown-relation-table']
  , [/duplicate column/, 'duplicate-column']
  , [/Duplicate table name/, 'duplicate-table']
  , [/cannot use x-link-any/, 'link-any-without-join']
  , [/x-access inherit/, 'bad-inherit']
  , [/foreign key column "[^"]+" does not exist/, 'missing-foreign-key-column']
  , [/needs a join table or an inverse one relation|needs a join table/, 'many-without-join']
  , [/unknown SRS keyword|unsupported keyword|: must /, 'invalid-schema']
  ]

/** Load inline schemas exactly as files would be loaded: system schemas added, meta-schema checked. */
const load =
  async (schemas: JSONSchema[]) => {
    const dir = await mkdtemp(join(tmpdir(), 'srs-conformance-'))
    try {
      await Promise.all(schemas.map((schema, index) => writeFile(join(dir, `${String(index).padStart(2, '0')}.json`), JSON.stringify(schema))))
      return await loadSchemas({ schemaDir: dir })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

/** Build inline schemas, reporting failures by their stable code. */
const build =
  async (schemas: JSONSchema[]): Promise<BuiltSchema> => {
    try {
      return buildSchema(await load(schemas))
    } catch (error) {
      const message = String((error as Error).message ?? error)
      const found = BUILD_ERRORS.find(([pattern]) => pattern.test(message))
      if (found) throw new ConformanceError(found[1], message)
      throw error
    }
  }

/** The database objects of a built schema, as key and statements, optionally only the system ones or only the others. */
const objectsOf =
  (built: BuiltSchema, system: Set<string>, only: 'system' | 'user') => {
    const owner = (key: string) => {
      const name = key.slice(key.indexOf(':') + 1)
      for (const table of system)
        if (name === table || name === `${table}_view` || name === `${table}_updated` || name.startsWith(`${table}_no_`)) return true
      return false
    }
    return databaseObjects(built)
      .filter(x => owner(x.key) === (only === 'system'))
      .map(x => ({ key: x.key, statements: x.statements }))
  }

/** A SQL parameter in JSON: bytes become `{ "hex": … }`. */
const param =
  (value: unknown) => value instanceof Uint8Array ? { hex: bytesToHex(value) } : value

/** A database that records every query and returns nothing, to see the SQL a read would run. */
const recorder =
  () => {
    const calls: { sql: string, params: unknown[] }[] = []
    const record = (sql: string, params: unknown[] = []) => { calls.push({ sql, params: params.map(param) }) }
    const db: RowDatabase =
      { all: async (sql, params) => { record(sql, params); return [] }
      , get: async (sql, params) => { record(sql, params); return { count: 0 } }
      , run: async (sql, params) => { record(sql, params); return { changes: 0 } as never }
      }
    return { calls, db }
  }

type ViewerInput = { user?: string, roles?: string[], anonymous?: boolean }
const viewer = (input: ViewerInput): Viewer => ({ userId: input.user, roles: input.roles ?? [], anonymous: input.anonymous === true })

type RowInput = { table: string, values: Record<string, unknown> }

/** Store a value the way its column expects: uuids as 16 bytes, booleans as 0 or 1. */
const stored =
  (built: BuiltSchema, table: string, column: string, value: unknown) => {
    const definition = built.orderedTables.find(x => x.tableName === table)
    const format = definition?.columns.find(x => x.columnName === column)?.schema
    if (value === null || value === undefined) return null
    if (format?.format === 'uuid') return uuidToBuffer(String(value))
    if (format?.type === 'boolean') return value ? 1 : 0
    return value
  }

/** The schema engine, query compiler and access operations, by name. */
export const engineOperations: Record<string, Operation> =
  { 'schema.build': async (input: { schemas: JSONSchema[], only?: 'system' | 'user' }) => {
      // System tables are the ones built from no schemas at all, including the join tables between them.
      const system = new Set((await build([])).orderedTables.map(x => x.tableName))
      return objectsOf(await build(input.schemas), system, input.only ?? 'user')
    }

  , 'schema.migrate': async (input: { before: JSONSchema[], after: JSONSchema[] }) => {
      const before = databaseObjects(await build(input.before))
      const after = databaseObjects(await build(input.after))
      return planMigration(after, stateOf(before))
    }

  , 'query.list': async (input: { schemas: JSONSchema[], resource: string, viewer: ViewerInput, query: string }) => {
      const built = await build(input.schemas)
      const registry = buildRegistry(built)
      const resource = registry.get(input.resource)
      if (!resource) throw new ConformanceError('unknown-resource')
      let query
      try {
        query = parseListQuery(new URLSearchParams(input.query), resource, registry)
      } catch (error) {
        throw new ConformanceError('bad-query', String(error))
      }
      const { calls, db } = recorder()
      const who = viewer(input.viewer)
      await listRows(
        db, new Map(built.orderedTables.map(x => [x.tableName, x])), resource, query
        , [readScope(who, resource, registry)]
        , (target, alias) => readScope(who, target, registry, alias))
      return calls
    }

  , 'access.decide': async (input:
      { schemas: JSONSchema[]
      , rows: RowInput[]
      , checks: { viewer: ViewerInput, operation: 'read' | 'update' | 'delete', resource: string, id: string }[]
      }) => {
      const loaded = await load(input.schemas)
      const built = buildSchema(loaded)
      const migrations = await mkdtemp(join(tmpdir(), 'srs-conformance-'))
      const log = console.log
      console.log = () => {}
      try {
        await generateMigrations(migrations, loaded)
      } finally {
        console.log = log
      }
      const connection = await connect(':memory:', { experimental: ['views', 'custom_types', 'encryption', 'vacuum'] })
      try {
        await connection.exec('PRAGMA foreign_keys = ON')
        await applyMigrations(connection, migrations)
        const db = createRowDatabase(connection)
        for (const row of input.rows)
          await insert(db, row.table
            , Object.fromEntries(Object.entries(row.values).map(([column, value]) => [column, stored(built, row.table, column, value)]))
            , built.orderedTables.find(x => x.tableName === row.table)?.idColumn)
        const registry = buildRegistry(built)
        const decisions: string[] = []
        for (const check of input.checks) {
          const resource = registry.get(check.resource)
          if (!resource) throw new ConformanceError('unknown-resource')
          const who = viewer(check.viewer)
          const scope =
            check.operation === 'read' ? readScope(who, resource, registry)
            : check.operation === 'update' ? writeScope(who, resource)
            : deleteScope(who, resource)
          const found =
            await db.get(
              `SELECT 1 AS found FROM ${fromSql(resource, resource.view)} WHERE ${keySql(resource, resource.view)} = ?`
              + `${scope.sql ? ` AND (${scope.sql})` : ''} LIMIT 1`
              , [keyParam(resource.definition, check.id), ...scope.params])
          decisions.push(found ? 'allow' : 'deny')
        }
        return decisions
      } finally {
        connection.close()
        await rm(migrations, { recursive: true, force: true })
      }
    }
  }
