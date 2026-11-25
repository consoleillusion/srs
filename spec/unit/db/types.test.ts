import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSchema } from '../../../src/db/build-schema.ts'
import { loadSchemas } from '../../../src/db/load-schemas.ts'
import { generateTypes } from '../../../src/db/types.ts'

describe('generated resource types', () => {
  test('cover every exposed resource and compile under strict TypeScript', async () => {
    const text = generateTypes(buildSchema(await loadSchemas()))
    expect(text).toContain('export type ArticleAttributes = {')
    expect(text).toContain('  heading?: string | null')
    expect(text).toContain('  readonly owner?: string | null')
    expect(text).toContain('  tag?: ToMany<"tag">')
    expect(text).toContain('export type Collection<T extends ResourceType> = { data: Resources[T][] }')
    expect(text).not.toContain('KeyAttributes')

    const dir = await mkdtemp(join(tmpdir(), 'srs-types-'))
    try {
      await writeFile(join(dir, 'types.ts'), text)
      await writeFile(join(dir, 'use.ts'),
        "import type { Collection, Single } from './types.ts'\n"
        + "const list: Collection<'article'> = { data: [{ type: 'article', id: 'x', attributes: { heading: 'Hi' } }] }\n"
        + "const one: Single<'tag'> = { data: { type: 'tag', id: 'y', attributes: {} } }\n"
        + 'void list; void one\n')
      const tsc = Bun.spawnSync(
        [join(import.meta.dir, '../../../node_modules/.bin/tsc'), '--noEmit', '--strict', '--allowImportingTsExtensions', '--module', 'preserve', 'types.ts', 'use.ts']
        , { cwd: dir })
      expect(new TextDecoder().decode(tsc.stdout)).toBe('')
      expect(tsc.exitCode).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
