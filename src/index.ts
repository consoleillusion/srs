/**
 * JSON Schema in, JSON:API server out.
 *
 * Takes JSON Schema files, builds the SQLite (Turso) tables, views and
 * migrations from them, and serves the result as JSON:API with password
 * accounts (OPAQUE), the Noise or bearer transport and per-row access control.
 *
 * @packageDocumentation
 */
export { init, serve } from './commands.ts'
export { createApp, type AppOptions } from './server/app/index.ts'
export { createServerApp } from './server/start.ts'
export { openDatabase } from './db/open.ts'
export { applyMigrations, type MigrationConnection, type MigrationStatement } from './db/migrate.ts'
export type { HttpOptions, LogSink } from './server/http.ts'
export { createServerKeys, createTransition, parseServerKeys, parseTransition, type KeyTransition } from './auth/server-keys.ts'
export type { PublicServerKeys, ServerKeys } from './protocol/server-keys.ts'
export { createMetrics, type Metrics } from './server/metrics.ts'
export { loadSchemas } from './db/load-schemas.ts'
export { buildSchema } from './db/build-schema.ts'
export type
  { BuiltSchema
  , JSONSchema
  , JSONSchemaProperty
  , LoadedSchema
  , AccessConfig
  , Cardinality
  , ColumnSql
  , Operation
  , Visibility
  , ColumnDef
  , ForeignKeyDef
  , RelationConfig
  , TableDef
  , ViewDef
  } from './db/schema-types.ts'
export type { Row, RowDatabase, RunResult, SqlConnection, SqlStatement, SqlTransactionFactory } from './server/database.ts'
