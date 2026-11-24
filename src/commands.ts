import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import * as opaque from '@serenity-kit/opaque'
import { generateMigrations } from './db/generate-migration.ts'
import { writeIfChanged } from './db/fs.ts'
import { loadSchemas } from './db/load-schemas.ts'
import type { LoadedSchema } from './db/schema-types.ts'
import { openDatabase } from './db/open.ts'
import { backupDatabase, restoreDatabase, startBackupSchedule } from './db/backup.ts'
import { DEFAULT_MAX_BODY_BYTES, httpOptionsFromEnv } from './server/http.ts'
import { createServerApp } from './server/start.ts'

export const defaultDir = '.srs'

type ProjectConfig =
  { version: 1
  , schemas: string[]
  , schemaHash: string
  }

const configPath = (dir: string) => join(dir, 'config.json')

/** Fingerprint of everything that decides the tables, so serve can tell the schemas changed since init. */
export const schemaHash =
  (loaded: LoadedSchema[]) => {
    const content = loaded.map(x => [x.importPath, x.schema])
    return createHash('sha256').update(JSON.stringify(content)).digest('hex')
  }

/** Read the settings written by init, or fail with the command to run. */
const readConfig =
  async (dir: string): Promise<ProjectConfig> => {
    const text = await readFile(configPath(dir), 'utf8').catch(() => undefined)
    if (text === undefined)
      throw new Error(`No ${configPath(dir)}. Run \`srs init <schema…>\` first.`)
    return JSON.parse(text) as ProjectConfig
  }

/** The existing OPAQUE server key, or a new one only when none is set (never replace a key). */
const serverKey =
  async () => {
    const existing = process.env.OPAQUE_SERVER_SETUP
    if (existing) return { value: existing, created: false }
    await opaque.ready
    return { value: opaque.server.createSetup(), created: true }
  }

/** Generate the migrations for the schemas into dir, record them, and print the settings to add to .env. */
export const init =
  async (options: { schemas: string[], dir?: string }) => {
    const dir = resolve(options.dir ?? defaultDir)
    if (options.schemas.length === 0)
      throw new Error('Give init a schema folder or files, e.g. `srs init schemas`.')

    const loaded = await loadSchemas({ schemaDir: options.schemas })
    const { built } = await generateMigrations(join(dir, 'migrations'), loaded)

    const config: ProjectConfig =
      { version: 1
      , schemas: options.schemas.map(x => relative(process.cwd(), resolve(x)) || '.')
      , schemaHash: schemaHash(loaded)
      }
    await writeIfChanged(configPath(dir), JSON.stringify(config, null, 2) + '\n')

    const key = await serverKey()
    console.log(`\nInitialised ${relative(process.cwd(), dir) || '.'} (${built.orderedTables.length} tables).`)
    if (key.created)
      console.log(`\nAdd this to your .env (keep it secret; changing it locks every user out):\n\n  OPAQUE_SERVER_SETUP=${key.value}\n`)
    else
      console.log('\nOPAQUE_SERVER_SETUP is already set, so it was kept.')
    console.log('Optional .env settings: DB_PATH (default .db), PORT (default 5734), SRS_ADMINS (comma-separated usernames).')
    console.log('\nThen run `srs serve`. Run init again after any schema change.')
  }

/** Start the server for the schemas recorded by init, refusing to run if they changed since. */
export const serve =
  async (options: { dir?: string, port?: number }) => {
    const dir = resolve(options.dir ?? defaultDir)
    const config = await readConfig(dir)
    const loaded = await loadSchemas({ schemaDir: config.schemas })
    if (schemaHash(loaded) !== config.schemaHash)
      throw new Error(
        'The schemas changed since `init`. Run `srs init '
        + `${config.schemas.join(' ')}\` again, then serve.`)

    const db = await openDatabase()
    const app = await createServerApp(
      { loaded
      , db
      , migrationsFolder: join(dir, 'migrations')
      })
    const port = options.port ?? Number(process.env.PORT ?? 5734)
    const server =
      Bun.serve(
        { port
        , fetch: app.fetch
        // Refuse oversized bodies at the socket, before the app reads them.
        , maxRequestBodySize: httpOptionsFromEnv().maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
        })
    console.log(`Server listening on http://localhost:${server.port}`)

    // Finish in-flight requests, then close the database, so a deploy never cuts a write short.
    const backupDir = process.env.SRS_BACKUP_DIR
    const stopBackups =
      backupDir
        ? await startBackupSchedule(
            db
            , { dir: resolve(backupDir)
              , intervalMs: Number(process.env.SRS_BACKUP_INTERVAL_HOURS ?? 24) * 3_600_000
              , keep: Number(process.env.SRS_BACKUP_KEEP ?? 7)
              })
        : undefined
    if (!backupDir)
      console.warn('SRS_BACKUP_DIR is not set, so no backups are being taken.')

    const shutdown =
      async () => {
        // Purpose: stop accepting connections, drain active requests, and close the database
        stopBackups?.()
        await server.stop()
        await db.close()
        process.exit(0)
      }
    process.once('SIGTERM', shutdown)
    process.once('SIGINT', shutdown)
    return server
  }

/** Copy the database to a new verified file. Run it with the server stopped, or use SRS_BACKUP_DIR while serving. */
export const backup =
  async (options: { file: string }) => {
    // Purpose: open the database and write one verified backup to the given file
    const db = await openDatabase()
    try {
      await backupDatabase(db, options.file)
    } finally {
      await db.close()
    }
    console.log(`Backed up to ${resolve(options.file)}`)
  }

/** Replace the database with a verified backup. The server must be stopped. */
export const restore =
  async (options: { file: string, force?: boolean }) => {
    // Purpose: verify the backup and swap it in as the database file
    const target = resolve(process.env.DB_PATH ?? '.db')
    await restoreDatabase(options.file, target, options.force)
    console.log(`Restored ${resolve(options.file)} to ${target}`)
  }
