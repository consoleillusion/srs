import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSchemas } from '../../../src/db/load-schemas.ts'
import { checkSchema } from '../../../src/db/meta-schema.ts'

let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'srs-meta-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const base = { title: 'Book', type: 'object', properties: { title: { type: 'string' } } }

describe('the schema meta-schema', () => {
  test('accepts every bundled schema', async () => {
    expect((await loadSchemas()).length).toBeGreaterThan(0)
  })

  test('names a misspelt standard keyword with its pointer', () => {
    expect(checkSchema({ ...base, requried: ['title'] })).toEqual(['/requried: unsupported keyword "requried"'])
    expect(checkSchema({ ...base, properties: { title: { type: 'string', maxLenght: 5 } } }))
      .toEqual(['/properties/title/maxLenght: unsupported keyword "maxLenght"'])
  })

  test('names an unknown SRS keyword', () => {
    expect(checkSchema({ ...base, 'x-acess': { read: 'public' } })).toEqual(['/x-acess: unknown SRS keyword "x-acess"'])
  })

  test('checks x-access values and lists what is allowed', () => {
    expect(checkSchema({ ...base, 'x-access': { read: 'everyone' } }))
      .toEqual(['/x-access/read: must be one of "session", "public"'])
    expect(checkSchema({ ...base, 'x-access': { signed: ['write'] } }))
      .toContain('/x-access/signed/0: must be one of "read", "create", "update", "delete"')
  })

  test('checks relations', () => {
    expect(checkSchema({ ...base, 'x-relations': { author: { table: 'user', cardinality: 'single' } } }))
      .toEqual(['/x-relations/author/cardinality: must be one of "one", "many"'])
    expect(checkSchema({ ...base, 'x-relations': { author: { cardinality: 'one' } } }))
      .toEqual(["/x-relations/author: must have required property 'table'"])
  })

  test('reports every problem at once', () => {
    expect(checkSchema({ ...base, requried: [], 'x-acess': {}, 'x-access': { read: 'x' } })).toHaveLength(3)
  })

  test('fails loading with the file and pointer, before any SQL is generated', async () => {
    await writeFile(join(dir, 'book.yaml'), 'title: Book\ntype: object\nproperties:\n  title:\n    type: string\n    maxLenght: 5\n')
    await expect(loadSchemas({ schemaDir: dir })).rejects.toThrow(/book\.yaml: document 1: invalid schema\n {2}\/properties\/title\/maxLenght: unsupported keyword "maxLenght"/)
  })
})
