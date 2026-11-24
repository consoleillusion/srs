import { describe, expect, test } from 'bun:test'
import { createServerKeys, createTransition, parseTransition } from '../src/auth/server-keys.ts'
import { createSecureClient } from '../src/client/secure.ts'
import { createApp } from '../src/server/app/index.ts'
import { createTestServer, opaqueServerSetup } from './helpers/test-server.ts'

const PASSWORD = 'correct horse battery staple'
const DAY = 24 * 60 * 60_000

/** A server whose app can be swapped, as a restart with new settings would. */
const setup =
  async () => {
    const { built, db } = await createTestServer({ session: true })
    const old = createServerKeys().keys
    const next = createServerKeys().keys
    let app = createApp({ built, db, opaqueServerSetup, requireSession: true, serverKeys: old })
    const fetch = (url: string | URL | Request, init?: RequestInit) => Promise.resolve(app.request(String(url), init))
    const restart = (options: Partial<Parameters<typeof createApp>[0]>) => {
      app = createApp({ built, db, opaqueServerSetup, requireSession: true, ...options } as Parameters<typeof createApp>[0])
    }
    return { old, next, fetch, restart }
  }

describe('server key rotation', () => {
  test('a client pinned to the old key follows a signed transition and reports the new pin', async () => {
    const { old, next, fetch, restart } = await setup()
    restart({ serverKeys: next, rotation: { previous: old, transition: createTransition(old, next, Date.now() + 30 * DAY).transition } })
    const pins: string[] = []
    const client = createSecureClient({ baseUrl: 'http://localhost', serverKey: old.fingerprint, fetch, onServerKeyChange: pin => pins.push(pin) })
    await client.register({ username: 'alice', password: PASSWORD })
    expect(pins).toEqual([next.fingerprint])
  })

  test('a client that connected before the rotation keeps working through it', async () => {
    const { old, next, fetch, restart } = await setup()
    const client = createSecureClient({ baseUrl: 'http://localhost', serverKey: old.fingerprint, fetch })
    await client.register({ username: 'alice', password: PASSWORD })
    restart({ serverKeys: next, rotation: { previous: old, transition: createTransition(old, next, Date.now() + 30 * DAY).transition } })
    // The restart ended the channel; the client re-handshakes with the old keys, which still work.
    await client.post('/note', { data: { type: 'note', attributes: { title: 'during rotation' } } })
  })

  test('after the stop date, the old keys are refused and an un-moved client must be repinned by hand', async () => {
    const { old, next, fetch, restart } = await setup()
    const client = createSecureClient({ baseUrl: 'http://localhost', serverKey: old.fingerprint, fetch })
    await client.register({ username: 'alice', password: PASSWORD })
    // The stop date has passed: the old keys no longer complete a handshake and no statement is offered.
    restart({ serverKeys: next, rotation: { previous: old, transition: createTransition(old, next, Date.now() - 1).transition } })
    await expect(client.get('/tag')).rejects.toThrow()
    const repinned = createSecureClient({ baseUrl: 'http://localhost', serverKey: next.fingerprint, fetch })
    await repinned.login({ username: 'alice', password: PASSWORD })
  })

  test('a transition not signed by the pinned key is refused', async () => {
    const { old, next, fetch, restart } = await setup()
    const impostor = createServerKeys().keys
    // An attacker serves their own keys, claiming a hand-over from the pinned keys, signed with their own key.
    restart({ serverKeys: next, rotation: { previous: old, transition: createTransition(impostor, next, Date.now() + DAY).transition } })
    const client = createSecureClient({ baseUrl: 'http://localhost', serverKey: old.fingerprint, fetch })
    await expect(client.get('/tag')).rejects.toThrow()
  })

  test('a client pinned to an unrelated key is refused', async () => {
    const { old, next, fetch, restart } = await setup()
    restart({ serverKeys: next, rotation: { previous: old, transition: createTransition(old, next, Date.now() + DAY).transition } })
    const client = createSecureClient({ baseUrl: 'http://localhost', serverKey: createServerKeys().keys.fingerprint, fetch })
    await expect(client.get('/tag')).rejects.toThrow()
  })

  test('the transition setting round-trips', () => {
    const old = createServerKeys().keys
    const next = createServerKeys().keys
    const { transition, setting } = createTransition(old, next, 1766592000000)
    expect(parseTransition(setting)).toEqual(transition)
  })
})
