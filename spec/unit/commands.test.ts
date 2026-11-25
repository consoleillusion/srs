import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createResourceServerClient, createSecureClient, memoryStorage } from '../../src/client/index.ts'

const cli = join(import.meta.dir, '../../src/cli.ts')
let project = ''

const book =
  (extra: Record<string, unknown> = {}) =>
    JSON.stringify(
      { title: 'Book'
      , type: 'object'
      , additionalProperties: false
      , properties: { name: { type: 'string' }, ...extra }
      })

const magazineYaml = `
title: Magazine
type: object
properties:
  name: { type: string }
---
title: Issue
type: object
properties:
  number: { type: integer }
`

/** Run the CLI in the throwaway project with a clean environment plus the given variables. */
const run =
  (args: string[], env: Record<string, string> = {}) => {
    const result =
      Bun.spawnSync(
        [process.execPath, cli, ...args],
        { cwd: project
        , env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }
        })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }

beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), 'rs-cli-'))
  await mkdir(join(project, 'schemas'))
  await writeFile(join(project, 'schemas/book.json'), book())
  await writeFile(join(project, 'schemas/magazine.yaml'), magazineYaml)
})

afterAll(() => rm(project, { recursive: true, force: true }))

describe('resource-server init and serve', () => {
  let key = ''
  let serverKeys = ''

  test('init generates migrations, config and a new server key', async () => {
    const result = run(['init', 'schemas'])
    expect(result.code).toBe(0)
    key = result.out.match(/OPAQUE_SERVER_SETUP=(\S+)/)?.[1] ?? ''
    expect(key.length).toBeGreaterThan(20)
    serverKeys = result.out.match(/SRS_SERVER_KEYS=(\S+)/)?.[1] ?? ''
    expect(serverKeys.startsWith('srs-keys-v1:')).toBe(true)
    expect(result.out).toMatch(/srs1:[a-z2-7]{52}/)
    const config = JSON.parse(await readFile(join(project, '.srs/config.json'), 'utf8'))
    expect(config.schemas).toEqual(['schemas'])
    expect(await readFile(join(project, '.srs/migrations/schema-state.json'), 'utf8')).toContain('table:book')
    expect(await readFile(join(project, '.srs/types.ts'), 'utf8')).toContain('export type BookAttributes')
  }, 60_000)

  test('init again keeps an existing key and prints none', () => {
    const result = run(['init', 'schemas'], { OPAQUE_SERVER_SETUP: key })
    expect(result.code).toBe(0)
    expect(result.out).toContain('was kept')
    expect(result.out).not.toContain(`OPAQUE_SERVER_SETUP=${key}`)
  }, 60_000)

  test('serve refuses to start without the server key bundle', () => {
    const result = run(['serve'], { OPAQUE_SERVER_SETUP: key })
    expect(result.code).toBe(1)
    expect(result.out).toContain('SRS_SERVER_KEYS is required')
  })

  test('serve refuses to start without the OPAQUE setup', () => {
    const result = run(['serve'], { SRS_TRANSPORT: 'bearer' })
    expect(result.code).toBe(1)
    expect(result.out).toContain('OPAQUE_SERVER_SETUP is required')
  })

  test('serve refuses an unknown transport', () => {
    const result = run(['serve'], { SRS_TRANSPORT: 'plain' })
    expect(result.code).toBe(1)
    expect(result.out).toContain('SRS_TRANSPORT must be')
  })

  test('serve starts and enforces sessions on every resource', async () => {
    const port = 5900 + Math.floor(Math.random() * 90)
    const baseUrl = `http://localhost:${port}`
    const child =
      Bun.spawn(
        [process.execPath, cli, 'serve', '--port', String(port)],
        { cwd: project
        , env: { PATH: process.env.PATH ?? '', OPAQUE_SERVER_SETUP: key, SRS_TRANSPORT: 'bearer' }
        , stdout: 'ignore'
        , stderr: 'ignore'
        })
    try {
      let status: number | undefined
      for (let i = 0; i < 50 && status === undefined; i++) {
        status = await fetch(`${baseUrl}/`).then(x => x.status).catch(() => undefined)
        if (status === undefined) await Bun.sleep(200)
      }
      // Sessions are enforced, so the catalog is closed to anonymous callers
      expect(status).toBe(401)

      const client = createResourceServerClient({ baseUrl, storage: memoryStorage() })
      await client.register({ username: 'tester', password: 'correct horse battery staple' }, { signIn: true })
      const catalog = await client.get<{ meta: { resources: { type: string }[] } }>('/')
      const types = catalog.meta.resources.map(x => x.type)
      expect(types).toContain('book')
      // Both YAML documents from one file become their own tables
      expect(types).toContain('magazine')
      expect(types).toContain('issue')
    } finally {
      child.kill()
    }
  }, 30_000)

  test('serve speaks the Noise transport by default, end to end over HTTP', async () => {
    const port = 5900 + Math.floor(Math.random() * 90)
    const baseUrl = `http://localhost:${port}`
    const child =
      Bun.spawn(
        [process.execPath, cli, 'serve', '--port', String(port)],
        { cwd: project
        , env: { PATH: process.env.PATH ?? '', OPAQUE_SERVER_SETUP: key, SRS_SERVER_KEYS: serverKeys }
        , stdout: 'ignore'
        , stderr: 'ignore'
        })
    try {
      let status: number | undefined
      for (let i = 0; i < 50 && status === undefined; i++) {
        status = await fetch(`${baseUrl}/tag`).then(x => x.status).catch(() => undefined)
        if (status === undefined) await Bun.sleep(200)
      }
      // Nothing is served in the clear.
      expect(status).toBe(426)

      const fingerprint = (await (await fetch(`${baseUrl}/noise/keys`)).json() as { fingerprint: string }).fingerprint
      const client = createSecureClient({ baseUrl, serverKey: fingerprint })
      await client.register({ username: 'noise-tester', password: 'correct horse battery staple' })
      const catalog = await client.get<{ meta: { resources: { type: string }[] } }>('/')
      expect(catalog.meta.resources.map(x => x.type)).toContain('book')

      // A client pinned to another key refuses to talk to this server.
      const wrong = createSecureClient({ baseUrl, serverKey: 'srs1:' + 'a'.repeat(52) })
      await expect(wrong.get('/')).rejects.toThrow()
    } finally {
      child.kill()
    }
  }, 30_000)

  test('serve refuses stale schemas until init is run again', async () => {
    await writeFile(join(project, 'schemas/book.json'), book({ author: { type: 'string' } }))
    const stale = run(['serve'], { OPAQUE_SERVER_SETUP: key })
    expect(stale.code).toBe(1)
    expect(stale.out).toContain('schemas changed')

    const again = run(['init', 'schemas'], { OPAQUE_SERVER_SETUP: key })
    expect(again.code).toBe(0)
    expect(again.out).toContain('was kept')
  }, 60_000)
})

describe('config errors', () => {
  test('an unreadable config is reported as unreadable, not as missing', async () => {
    const { mkdtemp, mkdir, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const project = await mkdtemp(join(tmpdir(), 'srs-unreadable-'))
    try {
      // A directory where the file should be cannot be read, like a mount the container may not read.
      await mkdir(join(project, '.srs', 'config.json'), { recursive: true })
      const result =
        Bun.spawnSync(
          [process.execPath, cli, 'serve']
          , { cwd: project, env: { PATH: process.env.PATH ?? '', SRS_TRANSPORT: 'bearer', OPAQUE_SERVER_SETUP: 'x' } })
      const out = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)
      expect(out).toContain('Cannot read')
      expect(out).toContain('EISDIR')
      expect(out).not.toContain('Run `srs init')
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })
})

describe('serve in a container', () => {
  test('says when nothing is mounted at the project folder, or the mounted folder has no init', async () => {
    const { mkdtempSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const cli = join(import.meta.dir, '../../src/cli.ts')
    const serveIn = (cwd: string) =>
      Bun.spawnSync(['bun', cli, 'serve'], { cwd, env: { PATH: process.env.PATH ?? '', SRS_IN_CONTAINER: '1' }, stdout: 'pipe', stderr: 'pipe' })
    const empty = mkdtempSync(join(tmpdir(), 'srs-mount-'))
    const result = serveIn(empty)
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('Nothing is mounted at')
    expect(result.stderr.toString()).toContain('-v "$PWD":/project:ro,z')
    mkdirSync(join(empty, 'schemas'))
    expect(serveIn(empty).stderr.toString()).toContain('has no .srs/config.json')
  })
})
