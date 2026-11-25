import { describe, expect, test } from 'bun:test'
import { buildSchema } from '../src/db/build-schema.ts'
import { signIn } from './helpers/session.ts'
import { createTestServer } from './helpers/test-server.ts'

/** Run one statement and return the error message, or undefined when it succeeds. */
const failure =
  async (connection: { exec: (sql: string) => Promise<unknown> }, sql: string) => {
    try {
      await connection.exec(sql)
      return undefined
    } catch (error) {
      return String(error)
    }
  }

describe('append-only tables', () => {
  test('audit_log rejects updates and deletes but accepts inserts', async () => {
    const { app, connection } = await createTestServer({ session: true })
    await signIn(app, 'alice')
    const count = async () =>
      ((await (await connection.prepare('SELECT count(*) AS n FROM audit_log')).all()) as { n: number }[])[0]!.n
    const before = await count()
    expect(before).toBeGreaterThan(0)

    expect(await failure(connection, "UPDATE audit_log SET action = 'forged'")).toContain('append-only')
    expect(await failure(connection, 'DELETE FROM audit_log')).toContain('append-only')
    expect(await count()).toBe(before)
  })

  test('x-append-only must be a boolean', () => {
    expect(() =>
      buildSchema(
        [ { importPath: 'x', exportName: 'X', source: 'test'
          , schema: { title: 'Thing', type: 'object', properties: {}, 'x-append-only': 'yes' }
          } as never
        ]))
      .toThrow('x-append-only must be a boolean')
  })
})
