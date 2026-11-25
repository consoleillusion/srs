/**
 * The HTTP conformance operation (design book, Conformance suites): start a
 * real server as a process from a case's schemas, register its users, and run
 * the case's requests through the Noise channel, the way any client would.
 * Nothing here reaches into the server's code, so another implementation is
 * checked by pointing the same runner at its binary.
 *
 * @module
 */
import { cp, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSecureClient, type SecureClient } from '../../src/client/index.ts'
import type { Operation } from './runner.ts'

/** How to start the server under test: `bun src/cli.ts` unless SRS_CONFORMANCE_SERVER names another command. */
const COMMAND =
  process.env.SRS_CONFORMANCE_SERVER?.split(' ')
  ?? ['bun', resolve(import.meta.dir, '../../src/cli.ts')]

const PASSWORD = 'conformance password 1'

/** One request of an HTTP case. */
type Step =
  { as?: string | null
  , clear?: boolean
  , method: string
  , path: string
  , headers?: Record<string, string>
  , body?: unknown
  /** The body as raw text, sent as is, for requests that are not JSON. */
  , raw?: string
  , select?: string[]
  , save?: Record<string, string>
  }

type HttpInput =
  { schemas?: unknown[]
  /** A folder of schema files in this repository, such as `src/schema`, instead of inline schemas. */
  , schemaDir?: string
  , users?: string[]
  , admins?: string[]
  , steps: Step[]
  }

/**
 * Read a path such as `data.0.id` from a JSON value. A part `[field=value]`
 * picks the first array element whose field has that value, and `length` of
 * an array is its length.
 */
const at =
  (value: unknown, path: string): unknown =>
    path.split('.').reduce<unknown>(
      (current, part) => {
        if (current === null || current === undefined) return undefined
        const match = part.match(/^\[([^=\]]+)=([^\]]*)\]$/)
        if (match && Array.isArray(current))
          return current.find(x => x && typeof x === 'object' && String((x as Record<string, unknown>)[match[1]!]) === match[2])
        if (Array.isArray(current) && /^\d+$/.test(part)) return current[Number(part)]
        if (Array.isArray(current) && part === 'length') return current.length
        return typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined
      }
      , value)

/** Replace `{{name}}` in every string of a JSON value. */
const fill =
  (value: unknown, saved: Map<string, string>): unknown => {
    if (typeof value === 'string')
      return value.replace(/\{\{([a-z0-9_.-]+)\}\}/gi, (_, name: string) => {
        const found = saved.get(name)
        if (found === undefined) throw new Error(`nothing saved as "${name}"`)
        return found
      })
    if (Array.isArray(value)) return value.map(x => fill(x, saved))
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, saved)]))
    return value
  }

/** Run a command to the end and return its output, or fail with it. */
const run =
  async (args: string[], cwd: string, env: Record<string, string>) => {
    const child = Bun.spawn([...COMMAND, ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
    const out = await new Response(child.stdout).text() + await new Response(child.stderr).text()
    if (await child.exited !== 0) throw new Error(`${args.join(' ')} failed:\n${out}`)
    return out
  }

/** Start the server and wait until it answers. */
const start =
  async (cwd: string, env: Record<string, string>, port: number) => {
    const child = Bun.spawn([...COMMAND, 'serve', '--port', String(port)], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
    for (let i = 0; i < 150; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/readyz`)).ok) return child
      } catch {
        // not listening yet
      }
      if (child.exitCode !== null) break
      await Bun.sleep(100)
    }
    child.kill()
    throw new Error(`the server did not start:\n${await new Response(child.stderr).text()}`)
  }

/** The HTTP operations, by name. */
export const httpOperations: Record<string, Operation> =
  { 'http.session': async (input: HttpInput) => {
      const dir = await mkdtemp(join(tmpdir(), 'srs-http-'))
      const port = 20000 + Math.floor(Math.random() * 20000)
      const base = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DB_PATH: join(dir, 'db'), SRS_LOG: 'false' }
      let server: ReturnType<typeof Bun.spawn> | undefined
      try {
        await mkdir(join(dir, 'schemas'))
        if (input.schemaDir) await cp(resolve(import.meta.dir, '../..', input.schemaDir), join(dir, 'schemas'), { recursive: true })
        await Promise.all((input.schemas ?? []).map((schema, index) =>
          writeFile(join(dir, 'schemas', `${String(index).padStart(2, '0')}.json`), JSON.stringify(schema))))
        const init = await run(['init', 'schemas'], dir, base)
        const pick = (name: string) => init.match(new RegExp(`${name}=(\\S+)`))?.[1] ?? ''
        const fingerprint = init.match(/srs1:[a-z2-7]+/)?.[0] ?? ''
        const env =
          { ...base, OPAQUE_SERVER_SETUP: pick('OPAQUE_SERVER_SETUP'), SRS_SERVER_KEYS: pick('SRS_SERVER_KEYS')
          , SRS_ADMINS: (input.admins ?? []).join(','), SRS_RATE_LIMIT_PER_MINUTE: '0' }
        server = await start(dir, env, port)
        const url = `http://127.0.0.1:${port}`
        const connect = () => createSecureClient({ baseUrl: url, serverKey: fingerprint })

        const saved = new Map<string, string>()
        const clients = new Map<string | null, SecureClient>([[null, connect()]])
        for (const name of input.users ?? []) {
          const client = connect()
          const { userId } = await client.register({ username: name, password: PASSWORD })
          if (!client.isSignedIn) await client.login({ username: name, password: PASSWORD })
          clients.set(name, client)
          saved.set(name, userId)
        }

        const results: Record<string, unknown>[] = []
        for (const step of input.steps) {
          const path = fill(step.path, saved) as string
          const body = step.raw ?? (step.body === undefined ? undefined : JSON.stringify(fill(step.body, saved)))
          const headers: Record<string, string> =
            { accept: 'application/vnd.api+json', ...(body ? { 'content-type': 'application/vnd.api+json' } : {}), ...step.headers }
          let status: number
          let json: unknown
          let responseHeaders: (name: string) => string | null
          if (step.clear) {
            const response = await fetch(`${url}${path}`, { method: step.method, headers, body })
            status = response.status
            responseHeaders = name => response.headers.get(name)
            json = await response.json().catch(() => undefined)
          } else {
            const client = clients.get(step.as ?? null)
            if (!client) throw new Error(`no user "${step.as}"`)
            const response = await client.request(path, { method: step.method, headers, body })
            status = response.status
            responseHeaders = name => response.headers.get(name) ?? null
            json = (() => { try { return response.json() } catch { return undefined } })()
          }
          for (const [name, from] of Object.entries(step.save ?? {})) saved.set(name, String(at(json, from)))
          // `header:<name>` selects a response header; ids in a Location header are replaced by `{id}`.
          const value =
            (path: string) =>
              path.startsWith('header:')
                ? path === 'header:location'
                  ? responseHeaders('location')?.replace(/\/[^/]+$/, '/{id}').replace(/^https?:\/\/[^/]+/, '') ?? null
                  : responseHeaders(path.slice(7))
                : at(json, path) ?? null
          results.push({ status, ...Object.fromEntries((step.select ?? []).map(x => [x, value(x)])) })
        }
        return results
      } finally {
        server?.kill()
        await server?.exited
        await rm(dir, { recursive: true, force: true })
      }
    }
  }
