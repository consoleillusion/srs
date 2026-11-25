import { describe, expect, test } from 'bun:test'
import { createServerKeys } from '../src/auth/server-keys.ts'
import { initiator } from '../src/protocol/noise.ts'
import { srsPrologue } from '../src/protocol/server-keys.ts'
import { createApp } from '../src/server/app/index.ts'
import { createChannelStore, REPLAY_WINDOW } from '../src/server/channels.ts'
import { NOISE_MEDIA_TYPE } from '../src/server/noise-handshake.ts'
import { createTestServer, opaqueServerSetup } from './helpers/test-server.ts'

/** A server with a fresh key bundle. */
const setup =
  async () => {
    const { built, db } = await createTestServer({ session: true })
    const { keys } = createServerKeys()
    return { app: createApp({ built, db, opaqueServerSetup, requireSession: true, serverKeys: keys }), keys }
  }

const post =
  (app: { request: (path: string, init: RequestInit) => Response | Promise<Response> }, body: Uint8Array) =>
    app.request('/noise/handshake', { method: 'POST', headers: { 'content-type': NOISE_MEDIA_TYPE }, body })

describe('POST /noise/handshake', () => {
  test('completes the NK handshake and returns a 16-byte channel id', async () => {
    const { app, keys } = await setup()
    const client = initiator({ prologue: srsPrologue(keys), responderStatic: keys.x25519 })
    const response = await post(app, client.writeMessage1(new Uint8Array(0)))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(NOISE_MEDIA_TYPE)
    const { payload, result } = client.readMessage2(new Uint8Array(await response.arrayBuffer()))
    expect(payload.length).toBe(16)
    expect(result.handshakeHash.length).toBe(32)
  })

  test('a client pinned to another server cannot complete it', async () => {
    const { app } = await setup()
    const other = createServerKeys().keys
    const client = initiator({ prologue: srsPrologue(other), responderStatic: other.x25519 })
    expect((await post(app, client.writeMessage1(new Uint8Array(0)))).status).toBe(400)
  })

  test('refuses malformed messages with the same answer', async () => {
    const { app, keys } = await setup()
    const valid = initiator({ prologue: srsPrologue(keys), responderStatic: keys.x25519 }).writeMessage1(new Uint8Array(0))
    const tampered = valid.slice(); tampered[40]! ^= 1
    const withPayload = initiator({ prologue: srsPrologue(keys), responderStatic: keys.x25519 }).writeMessage1(Uint8Array.of(1))
    for (const body of [new Uint8Array(0), valid.slice(0, 47), tampered, withPayload, new Uint8Array(48)]) {
      const response = await post(app, body)
      expect(response.status).toBe(400)
      expect(JSON.stringify(await response.json())).toContain('Handshake failed')
    }
  })

  test('is rate-limited per client address', async () => {
    const { app, keys } = await setup()
    let last = 0
    for (let i = 0; i < 61; i++)
      last = (await post(app, initiator({ prologue: srsPrologue(keys), responderStatic: keys.x25519 }).writeMessage1(new Uint8Array(0)))).status
    expect(last).toBe(429)
  })
})

describe('channel replay window', () => {
  const result = { initiatorToResponder: new Uint8Array(32), responderToInitiator: new Uint8Array(32), handshakeHash: new Uint8Array(32) }

  test('accepts each counter once, in any order inside the window', () => {
    const store = createChannelStore()
    const channel = store.open(new Uint8Array(16), result)
    for (const n of [5n, 0n, 3n, 6n]) {
      expect(store.fresh(channel, n)).toBe(true)
      store.accept(channel, n)
    }
    for (const n of [5n, 0n, 3n, 6n]) expect(store.fresh(channel, n)).toBe(false)
    expect(store.fresh(channel, 4n)).toBe(true)
  })

  test('refuses counters that fell out of the window', () => {
    const store = createChannelStore()
    const channel = store.open(new Uint8Array(16), result)
    store.accept(channel, 0n)
    store.accept(channel, REPLAY_WINDOW + 10n)
    expect(store.fresh(channel, 5n)).toBe(false)
    expect(store.fresh(channel, 11n)).toBe(true)
    expect(store.fresh(channel, REPLAY_WINDOW + 10n)).toBe(false)
  })

  test('ends unauthenticated channels after ten minutes', () => {
    const store = createChannelStore()
    const sid = new Uint8Array(16)
    store.open(sid, result, 0)
    expect(store.get(sid, 9 * 60_000)).toBeDefined()
    expect(store.get(sid, 10 * 60_000)).toBeUndefined()
  })
})
