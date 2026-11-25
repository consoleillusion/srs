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
import { resourceDocument, signIn, toMany } from './helpers/session.ts'
import { opaqueServerSetup } from './helpers/test-server.ts'

/** A to-many relation marked `required: true` always keeps at least one member. */
const scratch: string[] = []
afterAll(async () => { for (const dir of scratch) await rm(dir, { recursive: true, force: true }) })

describe('required to-many relations', () => {
  test('creates, replacements and removals cannot leave it empty', async () => {
    const loaded = await loadSchemas({ schemaDir: join(import.meta.dir, 'fixtures', 'required-many') })
    const migrations = await mkdtemp(join(tmpdir(), 'srs-required-'))
    scratch.push(migrations)
    await generateMigrations(migrations, loaded)
    const connection = await connect(':memory:', { experimental: ['views', 'custom_types', 'encryption', 'vacuum'] })
    await connection.exec('PRAGMA foreign_keys = ON')
    await applyMigrations(connection, migrations)
    const app = createApp({ built: buildSchema(loaded), db: createRowDatabase(connection), opaqueServerSetup, requireSession: true })
    const alice = await signIn(app, 'alice')
    const label = async (name: string) => ((await (await alice.request('POST', '/label', resourceDocument('label', { name }))).json()) as any).data.id as string
    const a = await label('a')
    const b = await label('b')

    const missing = await alice.request('POST', '/question', resourceDocument('question', { text: 'Q' }))
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as any).errors[0].source.parameter).toBe('data.relationships.tags')
    expect((await alice.request('POST', '/question', resourceDocument('question', { text: 'Q' }, { tags: toMany('label', []) }))).status).toBe(400)

    const created = await alice.request('POST', '/question', resourceDocument('question', { text: 'Q' }, { tags: toMany('label', [a]) }))
    expect(created.status).toBe(201)
    const q = ((await created.json()) as any).data.id

    expect((await alice.request('PATCH', `/question/${q}`, { data: { type: 'question', id: q, attributes: { text: 'Q2' } } })).status).toBe(200)
    expect((await alice.request('PUT', `/question/${q}`, { data: { type: 'question', id: q, attributes: { text: 'Q3' } } })).status).toBe(400)
    expect((await alice.request('PATCH', `/question/${q}/relationships/tags`, toMany('label', []))).status).toBe(400)
    expect((await alice.request('DELETE', `/question/${q}/relationships/tags`, toMany('label', [a]))).status).toBe(400)
    expect((await alice.request('POST', `/question/${q}/relationships/tags`, toMany('label', [b]))).status).toBe(200)
    expect((await alice.request('DELETE', `/question/${q}/relationships/tags`, toMany('label', [a]))).status).toBe(200)
  })
})
