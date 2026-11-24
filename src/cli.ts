#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { config } from 'dotenv'

config({ quiet: true })

const { backup, defaultDir, init, restore, serve } = await import('./commands.ts')

const usage = `srs: JSON Schema in, JSON:API server out

  srs init <schema…> [--dir ${defaultDir}]
      Generate the database migrations for the schema folder(s) or file(s)
      into --dir, and print the settings to add to .env. Run it again after
      every schema change. An existing OPAQUE_SERVER_SETUP is never replaced.

  srs serve [--dir ${defaultDir}] [--port 5734]
      Apply the migrations and start the server. Set SRS_BACKUP_DIR to take
      scheduled backups while it runs.

  srs backup <file>
      Write a verified copy of the database (DB_PATH). Needs the server stopped.

  srs restore <file> [--force]
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
