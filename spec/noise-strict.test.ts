import { describe, expect, test } from 'bun:test'
import { createServerKeys } from '../src/auth/server-keys.ts'
import { openChannel } from '../src/client/channel.ts'
import { createApp } from '../src/server/app/index.ts'
import { signIn } from './helpers/session.ts'
import { createTestServer, JSON_API, opaqueServerSetup } from './helpers/test-server.ts'

const setup =
  async (transport?: 'noise' | 'bearer') => {
    const { built, db } = await createTestServer({ session: true })
    const { keys } = createServerKeys()
    const app = createApp({ built, db, opaqueServerSetup, requireSession: true, serverKeys: keys, transport })
    return { app, keys }
  }

describe('strict mode', () => {
  test('is the default when the server has a key bundle', async () => {
    const { app } = await setup()
    const response = await app.request('/tag', { headers: { accept: JSON_API } })
    expect(response.status).toBe(426)
  })

  test('serves only the clear routes outside a channel', async () => {
    const { app } = await setup('noise')
    expect((await app.request('/healthz')).status).toBe(200)
    expect((await app.request('/readyz')).status).toBe(200)
    expect((await app.request('/noise/keys')).status).toBe(200)
    for (const [method, path] of [['GET', '/'], ['GET', '/tag'], ['POST', '/key'], ['GET', '/user'], ['DELETE', '/key/x'], ['OPTIONS', '/tag']] as const)
      expect({ method, path, status: (await app.request(path, { method })).status }).toEqual({ method, path, status: 426 })
  })

  test('a bearer session cannot be used to get around the channel', async () => {
    const { built, db } = await createTestServer({ session: true })
    const { keys } = createServerKeys()
    const bearer = createApp({ built, db, opaqueServerSetup, requireSession: true })
    const alice = await signIn(bearer, 'alice')
    const strict = createApp({ built, db, opaqueServerSetup, requireSession: true, serverKeys: keys })
    const response = await strict.request('/user', { headers: { authorization: `Bearer ${alice.sessionId}`, accept: JSON_API } })
    expect(response.status).toBe(426)
  })

  test('requests inside the channel are served', async () => {
    const { app, keys } = await setup('noise')
    const fetch = (url: string | URL | Request, init?: RequestInit) => Promise.resolve(app.request(String(url), init))
    const channel = await openChannel({ fetch, baseUrl: 'http://localhost', serverKeys: keys })
    expect((await channel.send({ method: 'GET', path: '/tag', headers: [['accept', JSON_API]] })).status).toBe(200)
  })

  test('the bearer transport serves routes directly', async () => {
    const { app } = await setup('bearer')
    expect((await app.request('/tag', { headers: { accept: JSON_API } })).status).toBe(200)
  })

})
