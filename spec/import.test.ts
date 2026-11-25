import { afterAll, describe, expect, test } from 'bun:test'
import { connect } from '@tursodatabase/database'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importSchemas } from '../src/commands.ts'
import { buildSchema } from '../src/db/build-schema.ts'
import { generateMigrations } from '../src/db/generate-migration.ts'
import { copyRows, planImport } from '../src/db/import.ts'
import { loadSchemas } from '../src/db/load-schemas.ts'
import { applyMigrations } from '../src/db/migrate.ts'
import { createApp } from '../src/server/app/index.ts'
import { createRowDatabase } from '../src/server/database.ts'
import { writeShopDatabase } from './fixtures/shop-db.ts'
import { signIn } from './helpers/session.ts'
import { opaqueServerSetup } from './helpers/test-server.ts'

const scratch: string[] = []
afterAll(async () => { for (const dir of scratch) await rm(dir, { recursive: true, force: true }) })
const folder = async () => { const dir = await mkdtemp(join(tmpdir(), 'srs-import-')); scratch.push(dir); return dir }
const digest = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')

/** Import the shop database's schemas, build a server on them, and copy its rows, as the commands do. */
const imported =
  async () => {
    const dir = await folder()
    const source = join(dir, 'shop.db')
    writeShopDatabase(source)
    const out = join(dir, 'schemas')
    const log = console.log
    console.log = () => {}
    try { await importSchemas({ file: source, out, report: join(dir, 'import-report.md') }) } finally { console.log = log }
    const loaded = await loadSchemas({ schemaDir: out })
    const migrations = join(dir, 'migrations')
    await generateMigrations(migrations, loaded)
    const connection = await connect(':memory:', { experimental: ['views', 'custom_types', 'encryption', 'vacuum'] })
    await connection.exec('PRAGMA foreign_keys = ON')
    await applyMigrations(connection, migrations)
    const db = createRowDatabase(connection)
    const built = buildSchema(loaded)
    const app = createApp({ built, db, opaqueServerSetup, requireSession: true })
    return { dir, source, out, loaded, migrations, connection, db, built, app }
  }

describe('import', () => {
  test('writes one schema per table, keeping keys and foreign keys, and reports what it left out', async () => {
    const { dir, out } = await imported()
    expect((await readdir(out)).sort()).toEqual(['customers.yaml', 'order_items.yaml', 'orders.yaml', 'products.yaml', 'user_imported.yaml'])
    const orders = await readFile(join(out, 'orders.yaml'), 'utf8')
    expect(orders).toContain('x-primary: true')
    expect(orders).toContain('foreignKey: customer')
    expect(orders).toContain('onDelete: cascade')
    expect(orders).toContain('owner_source:')
    const report = await readFile(join(dir, 'import-report.md'), 'utf8')
    for (const expected of ['big_orders', 'user_imported', 'composite primary key', 'CHECK constraints', 'orders_placed', 'CURRENT_TIMESTAMP'])
      expect(report).toContain(expected)
  })

  test('the written schemas build, and building them again changes nothing', async () => {
    const { loaded, migrations } = await imported()
    expect((await generateMigrations(migrations, loaded)).migration).toBeUndefined()
  })

  test('rows are copied with their keys, owned by one user, and served by the API', async () => {
    const { source, app, db, built, connection } = await imported()
    const before = await digest(source)
    const paul = await signIn(app, 'paul')
    const counts = await copyRows(source, planImport(source), db, built.orderedTables, paul.userId)
    expect(counts).toEqual({ customers: 2, products: 2, orders: 2, order_items: 3, user_imported: 1 })
    expect(await digest(source)).toBe(before)

    const customer = await (await paul.request('GET', '/customers/7')).json() as { data: { attributes: Record<string, unknown> } }
    expect(customer.data.attributes).toMatchObject({ name: 'Ada', email: 'ada@example.com', active: true, created_at: Date.UTC(2024, 4, 1, 10) })
    const order = await (await paul.request('GET', '/orders/100?include=customers')).json() as { data: { relationships: { customers: { data: unknown } } }, included: { id: string }[] }
    expect(order.data.relationships.customers.data).toEqual({ type: 'customers', id: '7' })
    expect(order.included.map(x => x.id)).toEqual(['7'])
    const items = await (await paul.request('GET', '/order_items?filter[products.title]=Lamp')).json() as { data: unknown[] }
    expect(items.data).toHaveLength(2)
    expect((await paul.request('GET', '/products/DESK-2')).status).toBe(200)

    const bob = await signIn(app, 'bob')
    expect((await bob.request('GET', '/customers/7')).status).toBe(404)

    const audit = await (await connection.prepare("SELECT resource FROM audit_log WHERE action = 'import' ORDER BY rowid")).all() as { resource: string }[]
    expect(audit.map(x => x.resource)).toEqual(['customers', 'products', 'orders', 'order_items', 'user_imported'])

    await expect(copyRows(source, planImport(source), db, built.orderedTables, paul.userId)).rejects.toThrow('already has rows')
  })

  test('refuses to overwrite schema files without --force, and writes the same files again with it', async () => {
    const { source, out, dir } = await imported()
    const first = await readFile(join(out, 'orders.yaml'), 'utf8')
    const quiet = async (run: () => Promise<unknown>) => { const log = console.log; console.log = () => {}; try { return await run() } finally { console.log = log } }
    await expect(quiet(() => importSchemas({ file: source, out, report: join(dir, 'r.md') }))).rejects.toThrow('--force')
    await quiet(() => importSchemas({ file: source, out, force: true, report: join(dir, 'r.md') }))
    expect(await readFile(join(out, 'orders.yaml'), 'utf8')).toBe(first)
  })
})
