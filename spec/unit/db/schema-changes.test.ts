import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { connect } from '@tursodatabase/database'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateMigrations } from '../../../src/db/generate-migration.ts'
import { loadSchemas } from '../../../src/db/load-schemas.ts'
import { applyMigrations } from '../../../src/db/migrate.ts'

let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'srs-change-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const book = (extra: string) =>
  `title: Book\ntype: object\nproperties:\n  title:\n    type: string\n${extra}required:\n  - title\n`

/** Generate and apply migrations for the schema as it now stands. */
const migrate =
  async (connection: Awaited<ReturnType<typeof connect>>) => {
    await generateMigrations(join(dir, 'migrations'), await loadSchemas({ schemaDir: join(dir, 'schemas') }))
    await applyMigrations(connection, join(dir, 'migrations'))
  }

const setup =
  async () => {
    await Bun.write(join(dir, 'schemas', 'book.yaml'), book(''))
    const connection = await connect(':memory:', { experimental: ['views', 'custom_types', 'encryption', 'vacuum'] })
    await migrate(connection)
    await connection.exec("INSERT INTO book (title) VALUES ('Dune')")
    const titles = async () => ((await (await connection.prepare('SELECT title FROM book')).all()) as { title: string }[]).map(x => x.title)
    return { connection, titles }
  }

describe('schema changes and existing data', () => {
  test('adding an optional column keeps every row', async () => {
    const { connection, titles } = await setup()
    await writeFile(join(dir, 'schemas', 'book.yaml'), book('  isbn:\n    type: string\n'))
    await migrate(connection)
    expect(await titles()).toEqual(['Dune'])
  })

  test('adding a required column without a default fails and changes nothing', async () => {
    const { connection, titles } = await setup()
    await writeFile(join(dir, 'schemas', 'book.yaml'), book('  isbn:\n    type: string\n').replace('  - title\n', '  - title\n  - isbn\n'))
    await expect(migrate(connection)).rejects.toThrow()
    expect(await titles()).toEqual(['Dune'])
  })

  test('renaming a column drops the old values', async () => {
    const { connection } = await setup()
    await writeFile(join(dir, 'schemas', 'book.yaml'), 'title: Book\ntype: object\nproperties:\n  name:\n    type: string\n')
    await migrate(connection)
    const rows = await (await connection.prepare('SELECT * FROM book')).all() as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBeNull()
  })
})
