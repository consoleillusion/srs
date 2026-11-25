import { describe, expect, test } from 'bun:test'
import { signIn } from './helpers/session.ts'
import { createTestServer } from './helpers/test-server.ts'

describe('key history is kept', () => {
  test('a user who owns keys cannot be deleted', async () => {
    const { app, connection } = await createTestServer({ session: true })
    const alice = await signIn(app, 'alice')
    const response = await alice.request('DELETE', `/user/${alice.userId}`)
    expect(response.status).toBe(409)
    const users = await (await connection.prepare('SELECT count(*) AS n FROM user')).all() as { n: number }[]
    expect(users[0]!.n).toBe(1)
  })
})
