import { afterAll, describe, expect, test } from 'bun:test'
import { connect } from '@tursodatabase/database'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSchema } from '../src/db/build-schema.ts'
import { generateMigrations } from '../src/db/generate-migration.ts'
import { loadSchemas } from '../src/db/load-schemas.ts'
import { applyMigrations } from '../src/db/migrate.ts'
import { createApp } from '../src/server/app/index.ts'
import { createRowDatabase } from '../src/server/database.ts'
import { resourceDocument, signIn, toMany, toOne } from './helpers/session.ts'
import { opaqueServerSetup } from './helpers/test-server.ts'

/**
 * Tables keyed by a declared `x-primary` property instead of the generated
 * uuid `id`: an integer the database assigns (customer), text the client
 * chooses (product), and the usual uuid (sale) linking both.
 */
const SCHEMAS = join(import.meta.dir, 'fixtures', 'declared-keys')
const scratch: string[] = []
afterAll(async () => { for (const dir of scratch) await rm(dir, { recursive: true, force: true }) })

const server =
  async () => {
    const loaded = await loadSchemas({ schemaDir: SCHEMAS })
    const migrations = await mkdtemp(join(tmpdir(), 'srs-keys-'))
    scratch.push(migrations)
    await generateMigrations(migrations, loaded)
    const connection = await connect(':memory:', { experimental: ['views', 'custom_types', 'encryption', 'vacuum'] })
    await connection.exec('PRAGMA foreign_keys = ON')
    await applyMigrations(connection, migrations)
    const app = createApp({ built: buildSchema(loaded), db: createRowDatabase(connection), opaqueServerSetup, requireSession: true })
    return { app, connection, migrations, loaded }
  }

type Doc = { data: any, included?: { type: string, id: string }[], meta?: { resources?: { type: string, description: { attributes: Record<string, unknown> } }[] } } // eslint-disable-line @typescript-eslint/no-explicit-any
const json = async (response: Response) => await response.json() as Doc

describe('declared primary keys', () => {
  test('an integer key is assigned by the database and is the resource id', async () => {
    const { app } = await server()
    const alice = await signIn(app, 'alice')
    const first = await alice.request('POST', '/customer', resourceDocument('customer', { name: 'Ada' }))
    expect(first.status).toBe(201)
    const created = (await json(first)).data as { id: string, attributes: Record<string, unknown> }
    expect(created.id).toBe('1')
    expect(created.attributes).not.toHaveProperty('customer_no')
    expect(first.headers.get('location')).toEndWith('/customer/1')

    const named = await alice.request('POST', '/customer', { data: { type: 'customer', id: '42', attributes: { name: 'Bo' } } })
    expect(named.status).toBe(201)
    expect(((await json(named)).data as { id: string }).id).toBe('42')

    for (const bad of ['abc', '042', '1.5', ''])
      expect((await alice.request('POST', '/customer', { data: { type: 'customer', id: bad, attributes: { name: 'X' } } })).status).toBe(400)

    expect(((await json(await alice.request('GET', '/customer/42'))).data as { attributes: Record<string, unknown> }).attributes.name).toBe('Bo')
    expect((await alice.request('GET', '/customer/7')).status).toBe(404)
    expect((await alice.request('GET', '/customer/not-a-number')).status).toBe(404)

    const patched = await alice.request('PATCH', '/customer/42', { data: { type: 'customer', id: '42', attributes: { name: 'Bob' } } })
    expect(patched.status).toBe(200)
    expect((await alice.request('DELETE', '/customer/42')).status).toBe(204)
    expect((await alice.request('GET', '/customer/42')).status).toBe(404)
  })

  test('a text key is chosen by the client', async () => {
    const { app } = await server()
    const alice = await signIn(app, 'alice')
    expect((await alice.request('POST', '/product', resourceDocument('product', { title: 'Lamp' }))).status).toBe(400)
    const created = await alice.request('POST', '/product', { data: { type: 'product', id: 'LAMP-1', attributes: { title: 'Lamp' } } })
    expect(created.status).toBe(201)
    expect(((await json(created)).data as { id: string }).id).toBe('LAMP-1')
    expect((await alice.request('POST', '/product', { data: { type: 'product', id: 'LAMP-1', attributes: { title: 'Again' } } })).status).toBe(409)
    expect(((await json(await alice.request('GET', '/product/LAMP-1'))).data as { attributes: { title: string } }).attributes.title).toBe('Lamp')
  })

  test('relations, includes, related filters and many-to-many links use the declared keys', async () => {
    const { app } = await server()
    const alice = await signIn(app, 'alice')
    await alice.request('POST', '/customer', resourceDocument('customer', { name: 'Ada' }))
    await alice.request('POST', '/product', { data: { type: 'product', id: 'LAMP-1', attributes: { title: 'Lamp' } } })
    await alice.request('POST', '/product', { data: { type: 'product', id: 'DESK-2', attributes: { title: 'Desk' } } })

    const sale =
      await alice.request('POST', '/sale'
        , resourceDocument('sale', { note: 'first' }
          , { customer: toOne('customer', '1'), products: toMany('product', ['LAMP-1', 'DESK-2']) }))
    expect(sale.status).toBe(201)
    const saleId = ((await json(sale)).data as { id: string }).id
    expect(saleId).toMatch(/^[0-9a-f-]{36}$/)

    const read = await json(await alice.request('GET', `/sale/${saleId}?include=customer,products`))
    const data = read.data as { relationships: Record<string, { data: unknown }> }
    expect(data.relationships.customer!.data).toEqual({ type: 'customer', id: '1' })
    expect((data.relationships.products!.data as { id: string }[]).map(x => x.id).sort()).toEqual(['DESK-2', 'LAMP-1'])
    expect(read.included!.map(x => `${x.type}:${x.id}`).sort()).toEqual(['customer:1', 'product:DESK-2', 'product:LAMP-1'])

    const filtered = await json(await alice.request('GET', '/sale?filter[customer.name]=Ada'))
    expect((filtered.data as { id: string }[]).map(x => x.id)).toEqual([saleId])
    expect(((await json(await alice.request('GET', '/sale?filter[customer.name]=Nobody'))).data as unknown[])).toEqual([])

    const relationship = await json(await alice.request('GET', `/sale/${saleId}/relationships/products`))
    expect((relationship.data as { id: string }[]).map(x => x.id).sort()).toEqual(['DESK-2', 'LAMP-1'])
    const replaced = await alice.request('PATCH', `/sale/${saleId}/relationships/products`, toMany('product', ['LAMP-1']))
    expect(replaced.status).toBe(200)
    expect(((await json(replaced)).data as { id: string }[]).map(x => x.id)).toEqual(['LAMP-1'])
    expect((await alice.request('PATCH', `/sale/${saleId}/relationships/customer`, toOne('customer', 'one'))).status).toBe(400)

    // A customer with a sale cannot be deleted out from under it.
    expect((await alice.request('DELETE', '/customer/1')).status).toBe(409)
  })

  test('sharing and the audit log work with an integer key', async () => {
    const { app, connection } = await server()
    const alice = await signIn(app, 'alice')
    const bob = await signIn(app, 'bob')
    await alice.request('POST', '/customer', resourceDocument('customer', { name: 'Ada', visibility: 'shared' }))
    expect((await bob.request('GET', '/customer/1')).status).toBe(404)
    const share =
      await alice.request('POST', '/customer_share'
        , resourceDocument('customer_share', { can_read: true, can_write: true }
          , { customer: toOne('customer', '1'), user: toOne('user', bob.userId) }))
    expect(share.status).toBe(201)
    expect((await bob.request('GET', '/customer/1')).status).toBe(200)
    expect((await bob.request('PATCH', '/customer/1', { data: { type: 'customer', id: '1', attributes: { name: 'Ada L' } } })).status).toBe(200)

    const audit =
      await (await connection.prepare("SELECT action, resource_id FROM audit_log WHERE resource = 'customer' ORDER BY rowid")).all() as { action: string, resource_id: string }[]
    expect(audit).toEqual([{ action: 'create', resource_id: '1' }, { action: 'update', resource_id: '1' }])
  })

  test('the catalog describes the key as the id, not an attribute', async () => {
    const { app } = await server()
    const alice = await signIn(app, 'alice')
    const catalog = await json(await alice.request('GET', '/'))
    const customer = catalog.meta!.resources!.find(x => x.type === 'customer')!
    expect(Object.keys(customer.description.attributes)).not.toContain('customer_no')
  })

  test('the key is in the schema, so init is repeatable: a second run changes nothing', async () => {
    const { migrations, loaded } = await server()
    const before = (await readdir(migrations)).length
    expect((await generateMigrations(migrations, loaded)).migration).toBeUndefined()
    expect((await readdir(migrations)).length).toBe(before)
  })

  test('schemas that cannot be keyed this way are refused', () => {
    const table = (properties: Record<string, unknown>) =>
      [{ importPath: 'x', exportName: 'X', source: 'test', schema: { title: 'Thing', type: 'object', properties } } as never]
    expect(() => buildSchema(table({ a: { type: 'integer', 'x-primary': true }, b: { type: 'string', 'x-primary': true } }))).toThrow('only one property can be x-primary')
    expect(() => buildSchema(table({ a: { type: 'number', 'x-primary': true } }))).toThrow('must be an integer or a string')
    expect(() => buildSchema(table({ a: { type: 'string', format: 'date-time', 'x-primary': true } }))).toThrow('cannot have format')
    expect(() => buildSchema(table({ code: { type: 'string', 'x-primary': true }, id: { type: 'string' } }))).toThrow('cannot also be a column "id"')
  })
})


