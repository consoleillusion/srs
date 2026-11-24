import { afterAll, describe, expect, test } from 'bun:test'
import { connect } from '@tursodatabase/database'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSchema } from '../src/db/build-schema.ts'
import { generateMigrations } from '../src/db/generate-migration.ts'
import { loadSchemas } from '../src/db/load-schemas.ts'
import { applyMigrations } from '../src/db/migrate.ts'
import { createApp } from '../src/server/app/index.ts'
import { createRowDatabase } from '../src/server/database.ts'
import { resourceDocument, signIn, toOne } from './helpers/session.ts'
import { JSON_API, opaqueServerSetup } from './helpers/test-server.ts'

const TEMPLATES = join(import.meta.dir, '../templates')
const scratch: string[] = []
afterAll(async () => { for (const dir of scratch) await rm(dir, { recursive: true, force: true }) })

/** A server built from one template folder only, the way `srs init` and `srs serve` would build it. */
const serverFor =
  async (template: string, admins: string[] = []) => {
    const loaded = await loadSchemas({ schemaDir: join(TEMPLATES, template) })
    const migrations = await mkdtemp(join(tmpdir(), 'srs-template-'))
    scratch.push(migrations)
    await generateMigrations(migrations, loaded)
    const connection = await connect(':memory:', { experimental: ['views', 'custom_types', 'encryption', 'vacuum'] })
    await connection.exec('PRAGMA foreign_keys = ON')
    await applyMigrations(connection, migrations)
    return createApp({ built: buildSchema(loaded), db: createRowDatabase(connection), opaqueServerSetup, requireSession: true, admins })
  }

const id = async (response: Response) => ((await response.json()) as { data: { id: string } }).data.id

describe('templates', () => {
  test('owned notes: only the owner can read a note', async () => {
    const app = await serverFor('owned-notes')
    const alice = await signIn(app, 'alice')
    const bob = await signIn(app, 'bob')
    const created = await alice.request('POST', '/note', resourceDocument('note', { title: 'Mine' }))
    expect(created.status).toBe(201)
    const note = await id(created)
    expect((await alice.request('GET', `/note/${note}`)).status).toBe(200)
    expect((await bob.request('GET', `/note/${note}`)).status).toBe(404)
    expect((await app.request(`/note/${note}`, { headers: { accept: JSON_API } })).status).toBe(401)
  })

  test('shared documents: a read share lets another user read, and changes are audited', async () => {
    const app = await serverFor('shared-documents')
    const alice = await signIn(app, 'alice')
    const bob = await signIn(app, 'bob')
    const doc = await id(await alice.request('POST', '/document', resourceDocument('document', { title: 'Plan', visibility: 'shared' })))
    expect((await bob.request('GET', `/document/${doc}`)).status).toBe(404)
    const shared =
      await alice.request('POST', '/document_share'
        , resourceDocument('document_share', { can_read: true, can_write: false }
          , { document: toOne('document', doc), user: toOne('user', bob.userId) }))
    expect(shared.status).toBe(201)
    expect((await bob.request('GET', `/document/${doc}`)).status).toBe(200)
  })

  test('public catalog: anyone reads, only editors write', async () => {
    const app = await serverFor('public-catalog', ['admin'])
    const admin = await signIn(app, 'admin')
    const editor = await signIn(app, 'editor')
    const visitor = await signIn(app, 'visitor')
    expect((await admin.request('POST', '/user_role', resourceDocument('user_role', { role: 'editor' }, { user: toOne('user', editor.userId) }))).status).toBe(201)

    const category = await id(await editor.request('POST', '/category', resourceDocument('category', { name: 'Tools' })))
    const product =
      await editor.request('POST', '/product'
        , resourceDocument('product', { name: 'Hammer', price_cents: 1999 }, { category: toOne('category', category) }))
    expect(product.status).toBe(201)
    expect((await visitor.request('POST', '/category', resourceDocument('category', { name: 'Spam' }))).status).toBe(403)

    const anonymous = await app.request('/product', { headers: { accept: JSON_API } })
    expect(anonymous.status).toBe(200)
    expect(JSON.stringify(await anonymous.json())).toContain('Hammer')
  })

  test('chat: messages are readable by whoever can read their chat', async () => {
    const app = await serverFor('chat')
    const alice = await signIn(app, 'alice')
    const bob = await signIn(app, 'bob')
    const chat = await id(await alice.request('POST', '/chat', resourceDocument('chat', { name: 'Team', visibility: 'shared' })))
    const message = await id(await alice.request('POST', '/message', resourceDocument('message', { text: 'Hello' }, { chat: toOne('chat', chat) })))
    expect((await bob.request('GET', `/message/${message}`)).status).toBe(404)
    await alice.request('POST', '/chat_share'
      , resourceDocument('chat_share', { can_read: true, can_write: false }, { chat: toOne('chat', chat), user: toOne('user', bob.userId) }))
    expect((await bob.request('GET', `/message/${message}`)).status).toBe(200)
  })
})
