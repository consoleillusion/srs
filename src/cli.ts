#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { config } from 'dotenv'

config({ quiet: true })

const { backup, consolePage, defaultDir, importData, importSchemas, init, invocation, restore, rotateKeys, serve, verifySignatures } = await import('./commands.ts')

const srs = invocation()
const usage = `${srs}: JSON Schema in, JSON:API server out

  ${srs} init <schema…> [--dir ${defaultDir}]
      Generate the database migrations for the schema folder(s) or file(s)
      into --dir, and print the settings to add to .env. Run it again after
      every schema change. An existing OPAQUE_SERVER_SETUP is never replaced.

  ${srs} serve [--dir ${defaultDir}] [--port 5734]
      Apply the migrations and start the server. Set SRS_BACKUP_DIR to take
      scheduled backups while it runs.

  ${srs} backup <file>
      Write a verified copy of the database (DB_PATH). Needs the server stopped.

  ${srs} import <file.db> [--out schemas] [--force]
      Read an existing SQLite database and write one schema per table, keeping
      its keys and foreign keys, and import-report.md. The file is only read.

  ${srs} import <file.db> --data --owner <username> [--dir .srs]
      Copy the rows into the database built from those schemas (after init and
      registering the owner). The server must be stopped.

  ${srs} console [--port 5735] [--host 127.0.0.1]
      Serve a browser page for using a server: connect with its fingerprint,
      register, log in, and list, create, update and delete resources. Use
      --host 0.0.0.0 to open it from another machine.

  ${srs} rotate-keys [--days 30]
      Create a new server key bundle and a transition statement signed by the
      current one (SRS_SERVER_KEYS). Pinned clients follow it for --days days.

  ${srs} verify-signatures
      Check every retained request signature against its certificate and the
      user's identity key, from the database alone. Needs the server stopped.

  ${srs} restore <file> [--force]
      Replace the database (DB_PATH) with a verified backup. Needs the server stopped.
`

/** Run the init or serve command named on the command line. */
const main =
  async () => {
    const { positionals, values } =
      parseArgs(
        { allowPositionals: true
        , options:
          { dir: { type: 'string', default: defaultDir }
          , port: { type: 'string' }
          , force: { type: 'boolean' }
          , days: { type: 'string' }
          , host: { type: 'string' }
          , out: { type: 'string' }
          , owner: { type: 'string' }
          , data: { type: 'boolean' }
          , help: { type: 'boolean', short: 'h' }
          }
        })
    const [command, ...rest] = positionals

    if (command === 'init') return init({ schemas: rest, dir: values.dir })
    if (command === 'serve')
      return serve(
        { dir: values.dir
        , port: values.port === undefined ? undefined : Number(values.port)
        })
    if (command === 'verify-signatures') return verifySignatures()
    if (command === 'import') {
      const file = positionals[1]
      if (!file) throw new Error(`Give import a database file, e.g. \`${srs} import shop.db\``)
      if (values.data) {
        if (!values.owner) throw new Error('import --data needs --owner <username>')
        return importData({ file, owner: values.owner, dir: values.dir })
      }
      return importSchemas({ file, out: values.out ?? 'schemas', force: values.force })
    }
    if (command === 'console')
      return consolePage({ port: values.port === undefined ? undefined : Number(values.port), host: values.host })
    if (command === 'rotate-keys') return rotateKeys({ days: values.days === undefined ? undefined : Number(values.days) })
    if (command === 'backup' || command === 'restore') {
      const [file] = rest
      if (!file) throw new Error(`Give ${command} a backup file path.`)
      return command === 'backup' ? backup({ file }) : restore({ file, force: values.force })
    }
    console.log(usage)
    if (!values.help && command !== undefined) process.exitCode = 1
  }

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
