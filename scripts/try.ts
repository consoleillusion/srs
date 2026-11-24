/**
 * `bun run try`: start a throwaway server on the sample schemas and the browser
 * console next to it, already configured for each other, and print what to
 * open. State lives in `.try/` (git-ignored); delete it to start again.
 *
 * Options: `--host 0.0.0.0` to open the console from another machine;
 * `--server-port` and `--console-port` (5734 and 5735); `--dir` for the state folder.
 *
 * @module
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dir, '..')
const { values } =
  parseArgs(
    { options:
      { host: { type: 'string', default: '127.0.0.1' }
      , dir: { type: 'string', default: join(root, '.try') }
      , 'server-port': { type: 'string', default: '5734' }
      , 'console-port': { type: 'string', default: '5735' }
      } })
const state = resolve(values.dir!)
const cli = join(root, 'src', 'cli.ts')
const consolePort = Number(values['console-port'])
const serverPort = Number(values['server-port'])

mkdirSync(state, { recursive: true })
const settingsFile = join(state, 'settings.json')

/** Run init once and keep its keys, so restarts keep the same accounts and fingerprint. */
const settings =
  (() => {
    if (existsSync(settingsFile))
      return JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, string>
    const result =
      Bun.spawnSync(['bun', cli, 'init', 'src/schema', '--dir', join(state, 'srs')],
        { cwd: root, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, stdout: 'pipe', stderr: 'pipe' })
    const out = result.stdout.toString()
    if (result.exitCode !== 0) throw new Error(`init failed:\n${out}${result.stderr.toString()}`)
    const pick = (name: string) => out.match(new RegExp(`${name}=(\\S+)`))?.[1]
    const created =
      { OPAQUE_SERVER_SETUP: pick('OPAQUE_SERVER_SETUP') ?? ''
      , SRS_SERVER_KEYS: pick('SRS_SERVER_KEYS') ?? ''
      , fingerprint: out.match(/srs1:[a-z2-7]+/)?.[0] ?? ''
      }
    if (!created.OPAQUE_SERVER_SETUP || !created.SRS_SERVER_KEYS || !created.fingerprint)
      throw new Error(`Could not read the keys from init's output:\n${out}`)
    writeFileSync(settingsFile, JSON.stringify(created, null, 2))
    return created
  })()

const keys = { OPAQUE_SERVER_SETUP: settings.OPAQUE_SERVER_SETUP!, SRS_SERVER_KEYS: settings.SRS_SERVER_KEYS! }
const base = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...keys }

// Re-run init with the same keys, so schema edits since the last run are picked up.
const init =
  Bun.spawnSync(['bun', cli, 'init', 'src/schema', '--dir', join(state, 'srs')],
    { cwd: root, env: base, stdout: 'pipe', stderr: 'pipe' })
if (init.exitCode !== 0) throw new Error(`init failed:\n${init.stdout}${init.stderr}`)

/** Every address the console page can be opened at, so the server allows each as an origin. */
const hosts =
  values.host === '0.0.0.0'
    ? ['127.0.0.1', 'localhost',
       ...Object.values(networkInterfaces()).flat().filter(x => x && x.family === 'IPv4' && !x.internal).map(x => x!.address)]
    : [values.host!, ...(values.host === '127.0.0.1' ? ['localhost'] : [])]
const origins = hosts.map(h => `http://${h}:${consolePort}`)

const server =
  Bun.spawn(['bun', cli, 'serve', '--dir', join(state, 'srs'), '--port', String(serverPort)],
    { cwd: root
    , env:
      { ...base, DB_PATH: join(state, 'db'), SRS_TRANSPORT: 'noise'
      , SRS_CORS_ORIGINS: origins.join(','), SRS_ADMINS: 'admin', SRS_LOG: 'false' }
    , stdout: 'inherit', stderr: 'inherit' })
const page =
  Bun.spawn(['bun', cli, 'console', '--port', String(consolePort), '--host', values.host!],
    { cwd: root, env: base, stdout: 'ignore', stderr: 'inherit' })

const stop = () => {
  server.kill()
  page.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

/** Wait until a URL answers, or give up after ten seconds. */
const ready =
  async (url: string) => {
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(url)
        return true
      } catch {
        await Bun.sleep(100)
      }
    }
    return false
  }

if (!(await ready(`http://127.0.0.1:${serverPort}/healthz`)) || !(await ready(`http://127.0.0.1:${consolePort}/`))) {
  console.error(`The server or the console did not start; see the errors above. Is port ${serverPort} or ${consolePort} in use?`)
  stop()
}

const shown = hosts.filter(h => h !== 'localhost')
console.log(`
Open the console:   ${shown.map(h => `http://${h}:${consolePort}/?pin=${settings.fingerprint}&server=http://${h}:${serverPort}`).join('\n               or  ')}
Server URL:         ${shown.map(h => `http://${h}:${serverPort}`).join('  or  ')}  (filled in)
Fingerprint:        ${settings.fingerprint}  (filled in)

Press Connect, then register any username and password. The username "admin"
gets the admin role. Data is kept in .try/; delete that folder to start again.
Ctrl-C stops both.
`)
