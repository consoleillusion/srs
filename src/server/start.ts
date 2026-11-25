import { buildSchema } from '../db/build-schema.ts'
import { applyMigrations } from '../db/migrate.ts'
import type { LoadedSchema } from '../db/schema-types.ts'
import type { MigrationConnection } from '../db/migrate.ts'
import type { RowDatabase, SqlConnection } from './database.ts'
import { parseServerKeys, parseTransition } from '../auth/server-keys.ts'
import { checkTransition } from '../protocol/server-keys.ts'
import { createApp } from './app/index.ts'
import { httpOptionsFromEnv } from './http.ts'
import type { Metrics } from './metrics.ts'
import { createRowDatabase } from './database.ts'

/** Split a comma-separated setting into trimmed, non-empty entries. */
const list =
  (value: string | undefined) => {
    return (value ?? '').split(',').map(x => x.trim()).filter(Boolean)
  }

/** Migrate the database, then build the HTTP app from the environment settings. */
export const createServerApp =
  async (options:
    { loaded: LoadedSchema[]
    /** The embedded database's connection; or give `rows` for another database. */
    , db?: MigrationConnection & SqlConnection
    , rows?: RowDatabase
    /** Where migrations are; without it they are not applied (serverless: apply them with the migrate command). */
    , migrationsFolder?: string
    , metrics?: Metrics
    /** Overrides SRS_TRANSPORT. */
    , transport?: 'noise' | 'bearer'
    /** The path the platform strips before the request reaches SRS; see AppOptions.basePath. */
    , basePath?: string
    }) => {
    const opaqueServerSetup = process.env.OPAQUE_SERVER_SETUP
    const transport = options.transport ?? process.env.SRS_TRANSPORT ?? 'noise'
    if (transport !== 'noise' && transport !== 'bearer')
      throw new Error(`SRS_TRANSPORT must be "noise" or "bearer", got "${transport}"`)
    if (transport === 'noise') {
      if (!process.env.SRS_SERVER_KEYS)
        throw new Error(
          'SRS_SERVER_KEYS is required for the Noise transport; run the init command (`bun src/cli.ts init <schemas>` in this repository) to create it, '
          + 'or set SRS_TRANSPORT=bearer to serve over TLS instead.')
      if (!opaqueServerSetup)
        throw new Error('OPAQUE_SERVER_SETUP is required; run the init command (`bun src/cli.ts init <schemas>` in this repository) to create it.')
    }
    if (!opaqueServerSetup)
      throw new Error('OPAQUE_SERVER_SETUP is required; the init command creates one.')

    const serverKeys = process.env.SRS_SERVER_KEYS ? parseServerKeys(process.env.SRS_SERVER_KEYS) : undefined
    const previousSetting = process.env.SRS_PREVIOUS_SERVER_KEYS
    const transitionSetting = process.env.SRS_KEY_TRANSITION
    if ((previousSetting === undefined) !== (transitionSetting === undefined))
      throw new Error('SRS_PREVIOUS_SERVER_KEYS and SRS_KEY_TRANSITION are set together, by the rotate-keys command')
    let rotation: { previous: ReturnType<typeof parseServerKeys>, transition: ReturnType<typeof parseTransition> } | undefined
    if (serverKeys && previousSetting && transitionSetting) {
      rotation = { previous: parseServerKeys(previousSetting), transition: parseTransition(transitionSetting) }
      // Refuse to serve a statement that clients would reject.
      checkTransition(rotation.previous, serverKeys, rotation.transition.stopAt, rotation.transition.signature)
    }

    // Bring the database up to date before serving; a failure stops the server.
    if (process.env.MIGRATE_ON_START !== 'false' && options.db && options.migrationsFolder)
      await applyMigrations(options.db, options.migrationsFolder)
    const rows = options.rows ?? (options.db ? createRowDatabase(options.db) : undefined)
    if (!rows) throw new Error('createServerApp needs a database')

    return createApp(
      { built: buildSchema(options.loaded)
      , db: rows
      , opaqueServerSetup
      , requireSession: true
      , http: { ...httpOptionsFromEnv(), metrics: options.metrics }
      , serverKeys
      , rotation
      , transport
      , retainReads: process.env.SRS_RETAIN_READS === 'true'
      , allowReset: process.env.SRS_ALLOW_RESET !== 'false'
      , admins: list(process.env.SRS_ADMINS)
      , basePath: options.basePath
      })
  }
