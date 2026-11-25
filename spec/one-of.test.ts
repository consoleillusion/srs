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
import { resourceDocument, signIn } from './helpers/session.ts'
import { opaqueServerSetup } from './helpers/test-server.ts'

/** A property declared only by `oneOf` is stored as JSON and read back as the same value. */
const scratch: string[] = []
afterAll(async () => { for (const dir of scratch) await rm(dir, { recursive: true, force: true }) })

describe('properties without a type', () => {
  test('a oneOf of objects round-trips, and table checks can read it as JSON', async () => {
    const loaded = await loadSchemas({ schemaDir: join(import.meta.dir, 'fixtures', 'one-of') })
    const migrations = await mkdtemp(join(tmpdir(), 'srs-one-of-'))
    scratch.push(migrations)
    const log = console.log
    console.log = () => {}
    try { await generateMigrations(migrations, loaded) } finally { console.log = log }
    const connection = await connect(':memory:', { experimental: ['views', 'custom_types', 'encryption', 'vacuum'] })
    await connection.exec('PRAGMA foreign_keys = ON')
    await applyMigrations(connection, migrations)
    const app = createApp({ built: buildSchema(loaded), db: createRowDatabase(connection), opaqueServerSetup, requireSession: true })
    const alice = await signIn(app, 'alice')

    const body = { kind: 'circle', radius: 2 }
    const created = await alice.request('POST', '/shape', resourceDocument('shape', { kind: 'circle', body }))
    expect(created.status).toBe(201)
    const id = ((await created.json()) as { data: { id: string } }).data.id
    const read = (await (await alice.request('GET', `/shape/${id}`)).json()) as { data: { attributes: { body: unknown } } }
    expect(read.data.attributes.body).toEqual(body)

    // The check compares body.kind with kind, so a mismatch is a conflict.
    const mismatch = await alice.request('POST', '/shape', resourceDocument('shape', { kind: 'square', body }))
    expect(mismatch.status).toBe(409)
    // A body that matches neither shape fails validation.
    expect((await alice.request('POST', '/shape', resourceDocument('shape', { kind: 'circle', body: { kind: 'circle' } }))).status).toBe(400)
  })
})
