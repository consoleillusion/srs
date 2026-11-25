import { afterAll, describe, expect, mock, test } from 'bun:test'
import { connect as connectLocal } from '@tursodatabase/database'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { generateMigrations } from '../src/db/generate-migration.ts'
import { loadSchemas } from '../src/db/load-schemas.ts'
import { resourceDocument, signedRequestAs, signIn, toOne } from './helpers/session.ts'
import { opaqueServerSetup } from './helpers/test-server.ts'

/**
 * The remote-database path and the serverless handler, with the Turso
 * serverless driver replaced by one that runs each statement on a local
 * database and records it. This checks what SRS sends; it does not reach
 * Turso Cloud.
 */
const local = await connectLocal(':memory:', { experimental: ['views', 'custom_types', 'encryption', 'vacuum'] })
const sent: string[] = []
// The pragma is per session; the stand-in keeps one, so turn foreign keys off to see that SRS turns them on.
await local.exec('PRAGMA foreign_keys = OFF')
const statement = async (sql: string) => await local.prepare(sql)
// Set to drop the next statements the way a closed pooled socket does, before they reach the database.
const drops = { left: 0, matching: /./ }
const send = (sql: string) => {
  if (drops.left > 0 && drops.matching.test(sql)) {
    drops.left--
    throw Object.assign(new Error('The socket connection was closed unexpectedly'), { code: 'ECONNRESET' })
  }
  sent.push(sql)
}
mock.module('@tursodatabase/serverless', () => ({
  connect: () => (
    { all: async (sql: string, ...params: unknown[]) => { send(sql); return (await statement(sql)).all(...params) }
    , get: async (sql: string, ...params: unknown[]) => { send(sql); return (await statement(sql)).get(...params) }
    , run: async (sql: string, ...params: unknown[]) => { send(sql); return (await statement(sql)).run(...params) }
    , exec: async (sql: string) => { send(sql); return local.exec(sql) }
    , close: async () => {}
    })
}))

const { applyMigrations } = await import('../src/db/migrate.ts')
const { migrationConnection, openRemote, remoteSettings } = await import('../src/db/remote.ts')
const { createHandler } = await import('../src/serverless.ts')

const scratch: string[] = []
afterAll(async () => { for (const dir of scratch) await rm(dir, { recursive: true, force: true }) })

describe('serverless handler over a remote database', () => {
  test('needs a remote database, and refuses the Noise transport', async () => {
    expect(remoteSettings({})).toBeUndefined()
    expect(() => remoteSettings({ SRS_DATABASE_URL: 'file:local.db' })).toThrow('Turso URL')
    await expect(createHandler({ schemas: [] })).rejects.toThrow('SRS_DATABASE_URL')
  })

  test('migrates, registers, logs in, and serves the API under a base path, with foreign keys on for writes', async () => {
    const env = { ...process.env }
    try {
      process.env.SRS_DATABASE_URL = 'libsql://test.example.turso.io'
      process.env.SRS_DATABASE_TOKEN = 'token'
      process.env.OPAQUE_SERVER_SETUP = opaqueServerSetup
      const loaded = await loadSchemas({ schemaDir: join(import.meta.dir, '../templates/shared-documents') })
      const migrations = await mkdtemp(join(tmpdir(), 'srs-serverless-'))
      scratch.push(migrations)
      const log = console.log
      console.log = () => {}
      try { await generateMigrations(migrations, loaded) } finally { console.log = log }
      await applyMigrations(migrationConnection(openRemote(remoteSettings()!)), migrations)

      const handle = await createHandler({ schemas: JSON.parse(JSON.stringify(loaded)), basePath: '/api' })
      const app = { request: (path: string, init?: RequestInit) => handle(new Request(`https://site.example/api${path}`, init)) } as unknown as Hono

      const alice = await signIn(app, 'alice')
      const bob = await signIn(app, 'bob')
      const created = await alice.request('POST', '/document', resourceDocument('document', { title: 'Plan', visibility: 'shared' }))
      expect(created.status).toBe(201)
      const createdDoc = (await created.json()) as { data: { id: string, links: { self: string } } }
      const id = createdDoc.data.id
      // Links include the mount path the handler strips.
      expect(created.headers.get('location')).toBe(`/api/document/${id}`)
      expect(createdDoc.data.links.self).toBe(`https://site.example/api/document/${id}`)

      // The client signs the path it sends, base included, and the server verifies that path.
      const site = { request: (path: string, init?: RequestInit) => handle(new Request(`https://site.example${path}`, init)) } as unknown as Hono
      const signed = await signedRequestAs(site, alice, 'POST', '/api/document', resourceDocument('document', { title: 'Signed' }))
      expect(signed.status).toBe(201)
      const unsigned = await signedRequestAs(app, alice, 'POST', '/document', resourceDocument('document', { title: 'Wrong path' }))
      expect(unsigned.status).toBe(401)
      expect((await bob.request('GET', `/document/${id}`)).status).toBe(404)
      const write = sent.length
      expect((await alice.request('POST', '/document_share'
        , resourceDocument('document_share', { can_read: true }, { document: toOne('document', id), user: toOne('user', bob.userId) }))).status).toBe(201)
      expect((await bob.request('GET', `/document/${id}`)).status).toBe(200)

      // The audited write ran in a transaction that turned foreign keys on before it began.
      const after = sent.slice(write)
      const begin = after.indexOf('BEGIN')
      expect(begin).toBeGreaterThan(0)
      expect(after[begin - 1]).toBe('PRAGMA foreign_keys = ON')
      expect(after).toContain('COMMIT')

      // A link to a row that does not exist is refused by the foreign key.
      expect((await alice.request('POST', '/document_share'
        , resourceDocument('document_share', { can_read: true }, { document: toOne('document', '01900000-0000-7000-8000-000000000000'), user: toOne('user', bob.userId) }))).status).toBe(404)

      expect((await handle(new Request('https://site.example/other'))).status).toBe(404)

      // SRS names every new row's uuid itself: Turso Cloud's uuid7() default returns text, not the 16 bytes SRS stores.
      const inserts = sent.filter(sql => sql.startsWith('INSERT INTO') && sql.endsWith('RETURNING `id`'))
      expect(inserts.length).toBeGreaterThan(0)
      for (const sql of inserts) expect(sql).toMatch(/^INSERT INTO `[a-z_]+` \(`id`/)

      // A read whose connection drops is sent again.
      drops.left = 1; drops.matching = /^SELECT/
      expect((await alice.request('GET', `/document/${id}`)).status).toBe(200)
      // So is a transaction that drops before COMMIT: the database rolled it back, so it runs again, once.
      drops.left = 1; drops.matching = /^INSERT INTO `document`/
      const retried = await alice.request('POST', '/document', resourceDocument('document', { title: 'Dropped once' }))
      expect(retried.status).toBe(201)
      const titles = (await (await alice.request('GET', '/document?filter[title]=Dropped once')).json()) as { data: unknown[] }
      expect(titles.data).toHaveLength(1)
      // A drop while committing is reported, not retried: the write may have been saved.
      drops.left = 1; drops.matching = /^COMMIT$/
      expect((await alice.request('POST', '/document', resourceDocument('document', { title: 'Commit dropped' }))).status).toBe(500)
    } finally {
      process.env = env
    }
  })
})
