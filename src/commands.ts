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
import { createMetrics, serveMetrics } from './server/metrics.ts'
import { verifyRetainedSignatures } from './db/verify-signatures.ts'
import { generateTypes } from './db/types.ts'
import { createRowDatabase } from './server/database.ts'
import { DEFAULT_MAX_BODY_BYTES, httpOptionsFromEnv } from './server/http.ts'
import { createServerApp } from './server/start.ts'
import { createServerKeys, createTransition, parseServerKeys } from './auth/server-keys.ts'

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
    let text: string
    try {
      text = await readFile(configPath(dir), 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT')
        throw new Error(`No ${configPath(dir)}. Run \`srs init <schema…>\` first, in ${process.cwd()}.`)
      // Anything else (permission denied, a bad mount) must not be reported as a missing file.
      throw new Error(
        `Cannot read ${configPath(dir)}: ${code ?? String(error)}. If the project is mounted into a `
        + 'container, check that the container user can read it (with Podman: add :z to the mount '
        + 'on SELinux systems, and run rootless with --userns=keep-id).')
    }
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
    await writeIfChanged(join(dir, 'types.ts'), generateTypes(built))

    const key = await serverKey()
    console.log(`\nInitialised ${relative(process.cwd(), dir) || '.'} (${built.orderedTables.length} tables).`)
    if (key.created)
      console.log(`\nAdd this to your .env (keep it secret; changing it locks every user out):\n\n  OPAQUE_SERVER_SETUP=${key.value}\n`)
    else
      console.log('\nOPAQUE_SERVER_SETUP is already set, so it was kept.')
    if (process.env.SRS_SERVER_KEYS)
      console.log(
        `\nSRS_SERVER_KEYS is already set, so it was kept. Clients pin:\n\n  ${parseServerKeys(process.env.SRS_SERVER_KEYS).fingerprint}\n`)
    else {
      const created = createServerKeys()
      console.log(
        '\nAdd this to your .env too (keep it secret; changing it breaks every pinned client):'
        + `\n\n  SRS_SERVER_KEYS=${created.setting}\n`
        + `\nGive clients this fingerprint to pin:\n\n  ${created.keys.fingerprint}\n`)
    }
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
    const metricsPort = process.env.SRS_METRICS_PORT
    if (metricsPort !== undefined && !/^\d+$/.test(metricsPort))
      throw new Error(`SRS_METRICS_PORT must be a port number, got "${metricsPort}"`)
    const metrics = metricsPort ? createMetrics() : undefined
    const app = await createServerApp(
      { loaded
      , db
      , migrationsFolder: join(dir, 'migrations')
      , metrics
      })
    const metricsServer = metrics && metricsPort ? serveMetrics(metrics, Number(metricsPort)) : undefined
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
              , onBackup: metrics?.backup
              })
        : undefined
    if (!backupDir)
      console.warn('SRS_BACKUP_DIR is not set, so no backups are being taken.')

    const shutdown =
      async () => {
        stopBackups?.()
        metricsServer?.stop()
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
    const target = resolve(process.env.DB_PATH ?? '.db')
    await restoreDatabase(options.file, target, options.force)
    console.log(`Restored ${resolve(options.file)} to ${target}`)
  }

/** Check every retained request signature in the database. The server must be stopped. */
export const verifySignatures =
  async () => {
    const db = await openDatabase()
    try {
      const results = await verifyRetainedSignatures(createRowDatabase(db))
      const invalid = results.filter(x => !x.valid)
      for (const result of results)
        console.log(
          `${result.valid ? 'ok     ' : 'INVALID'} ${result.auditId} ${result.action} ${result.resource}`
          + (result.reason ? ` (${result.reason})` : ''))
      console.log(`\n${results.length} retained signatures, ${invalid.length} invalid.`)
      if (invalid.length > 0) process.exitCode = 1
    } finally {
      await db.close()
    }
  }

/**
 * Start a server key rotation: create a new bundle and a transition statement
 * signed by the current one. Prints the settings to deploy.
 *
 * @param options - How many days the old keys keep working.
 */
export const rotateKeys =
  (options: { days?: number }) => {
    const current = process.env.SRS_SERVER_KEYS
    if (!current) throw new Error('SRS_SERVER_KEYS must be set to the bundle being replaced')
    const days = options.days ?? 30
    if (!Number.isFinite(days) || days < 1) throw new Error('--days must be at least 1')
    const previous = parseServerKeys(current)
    const next = createServerKeys()
    const stopAt = Date.now() + days * 24 * 60 * 60_000
    const { setting } = createTransition(previous, next.keys, stopAt)
    console.log(
      'Set these three settings (keep them secret), then restart:\n'
      + `\n  SRS_SERVER_KEYS=${next.setting}`
      + `\n  SRS_PREVIOUS_SERVER_KEYS=${current}`
      + `\n  SRS_KEY_TRANSITION=${setting}\n`
      + `\nClients pinned to ${previous.fingerprint} move to ${next.keys.fingerprint} on their own`
      + ` until ${new Date(stopAt).toISOString()}. After that, remove SRS_PREVIOUS_SERVER_KEYS and`
      + ' SRS_KEY_TRANSITION; clients that have not moved must be given the new fingerprint by hand.')
  }

/**
 * Serve the browser console for using a server over the Noise transport.
 *
 * @param options - Port and host for the console page.
 */
export const consolePage =
  async (options: { port?: number, host?: string }) => {
    const { serveConsole } = await import('./console/serve.ts')
    const server = await serveConsole(options)
    const origin = `http://${server.hostname === '0.0.0.0' ? 'YOUR-ADDRESS' : server.hostname}:${server.port}`
    console.log(
      `SRS console: ${origin}\n`
      + `\nThe page and the server are different origins, so start the server with:\n`
      + `\n  SRS_CORS_ORIGINS=${origin}\n`
      + '\nThen open the page, enter the server URL and the fingerprint printed by `srs init`, and connect.')
  }
