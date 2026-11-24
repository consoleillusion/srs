import { describe, expect, test } from 'bun:test'
import { createServerKeys } from '../src/auth/server-keys.ts'
import { openChannel, type Channel } from '../src/client/channel.ts'
import { decodeResponse, encodeRequest, open, parseEnvelope, seal } from '../src/protocol/envelope.ts'
import { initiator } from '../src/protocol/noise.ts'
import { srsPrologue, type ServerKeys } from '../src/protocol/server-keys.ts'
import { createApp } from '../src/server/app/index.ts'
import { NOISE_MEDIA_TYPE } from '../src/server/noise-handshake.ts'
import { createTestServer, JSON_API, opaqueServerSetup } from './helpers/test-server.ts'

type App = ReturnType<typeof createApp>

/** A server with a key bundle, and a fetch that calls it in-process. */
const setup =
  async () => {
    const { built, db } = await createTestServer({ session: true })
    const { keys } = createServerKeys()
    const app = createApp({ built, db, opaqueServerSetup, requireSession: true, serverKeys: keys })
    const fetch = (url: string | URL | Request, init?: RequestInit) => Promise.resolve(app.request(String(url), init))
    return { app, keys, fetch }
  }

/** Run the handshake by hand, keeping the keys, so tests can forge envelopes. */
const rawChannel =
  async (app: App, keys: ServerKeys) => {
    const handshake = initiator({ prologue: srsPrologue(keys), responderStatic: keys.x25519 })
    const response =
      await app.request('/noise/handshake'
        , { method: 'POST', headers: { 'content-type': NOISE_MEDIA_TYPE }, body: handshake.writeMessage1(new Uint8Array(0)) })
    const { payload: sid, result } = handshake.readMessage2(new Uint8Array(await response.arrayBuffer()))
    const envelope =
      (n: bigint, path = '/tag', method = 'GET', headers: [string, string][] = [['accept', JSON_API]]) =>
        seal(result.initiatorToResponder, sid, n
          , encodeRequest({ method, path, headers, body: new Uint8Array(0), signature: new Uint8Array(0) }))
    const post =
      (body: Uint8Array) =>
        app.request('/noise', { method: 'POST', headers: { 'content-type': NOISE_MEDIA_TYPE }, body })
    const read =
      async (response: Response, n: bigint) => {
        const parsed = parseEnvelope(new Uint8Array(await response.arrayBuffer()))
        return decodeResponse(open(result.responderToInitiator, sid, n, parsed.ciphertext))
      }
    return { sid, result, envelope, post, read }
  }

describe('the Noise envelope', () => {
  test('carries a request to the app and the response back', async () => {
    const { keys, fetch } = await setup()
    const channel: Channel = await openChannel({ fetch, baseUrl: 'http://localhost', serverKeys: keys })
    const response = await channel.send({ method: 'GET', path: '/tag', headers: [['accept', JSON_API]] })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(JSON_API)
    expect(Array.isArray(response.json<{ data: unknown[] }>()?.data)).toBe(true)
  })

  test('hides the method, path and body from the network', async () => {
    const { app, keys } = await setup()
    const raw = await rawChannel(app, keys)
    const envelope = raw.envelope(0n, '/article?filter[heading]=secret-search')
    expect(Buffer.from(envelope).toString('latin1')).not.toContain('secret-search')
    expect(Buffer.from(envelope).toString('latin1')).not.toContain('/article')
  })

  test('a replayed envelope is refused and nothing runs twice', async () => {
    const { app, keys } = await setup()
    const raw = await rawChannel(app, keys)
    const envelope = raw.envelope(0n)
    expect((await raw.post(envelope)).status).toBe(200)
    expect((await raw.post(envelope)).status).toBe(409)
  })

  test('accepts requests out of order inside the window', async () => {
    const { app, keys } = await setup()
    const raw = await rawChannel(app, keys)
    expect((await raw.post(raw.envelope(3n))).status).toBe(200)
    expect((await raw.post(raw.envelope(1n))).status).toBe(200)
    expect((await raw.post(raw.envelope(2n))).status).toBe(200)
  })

  test('a tampered envelope is refused without using up its counter', async () => {
    const { app, keys } = await setup()
    const raw = await rawChannel(app, keys)
    const envelope = raw.envelope(0n)
    const tampered = envelope.slice(); tampered[tampered.length - 1]! ^= 1
    expect((await raw.post(tampered)).status).toBe(400)
    expect((await raw.post(envelope)).status).toBe(200)
  })

  test('a counter changed in transit fails authentication', async () => {
    const { app, keys } = await setup()
    const raw = await rawChannel(app, keys)
    const envelope = raw.envelope(0n)
    envelope[27]! ^= 1
    expect((await raw.post(envelope)).status).toBe(400)
  })

  test('an envelope moved to another channel is refused', async () => {
    const { app, keys } = await setup()
    const a = await rawChannel(app, keys)
    const b = await rawChannel(app, keys)
    const moved = a.envelope(0n).slice()
    moved.set(b.sid, 4)
    expect((await a.post(moved)).status).toBe(400)
  })

  test('truncated and unknown envelopes get bare answers', async () => {
    const { app, keys } = await setup()
    const raw = await rawChannel(app, keys)
    expect((await raw.post(raw.envelope(0n).slice(0, 30))).status).toBe(400)
    const unknown = raw.envelope(1n).slice()
    unknown.set(new Uint8Array(16), 4)
    expect((await raw.post(unknown)).status).toBe(401)
  })

  test('the response is bound to its request counter', async () => {
    const { app, keys } = await setup()
    const raw = await rawChannel(app, keys)
    const response = await raw.post(raw.envelope(4n))
    const bytes = new Uint8Array(await response.clone().arrayBuffer())
    const parsed = parseEnvelope(bytes)
    expect(() => open(raw.result.responderToInitiator, raw.sid, 5n, parsed.ciphertext)).toThrow()
    expect((await raw.read(response, 4n)).status).toBe(200)
  })

  test('headers outside the allowed list are dropped, so a bearer token cannot be smuggled in', async () => {
    const { app, keys } = await setup()
    const raw = await rawChannel(app, keys)
    const response =
      await raw.post(raw.envelope(0n, '/user', 'GET', [['accept', JSON_API], ['authorization', 'Bearer 00000000-0000-4000-8000-000000000000']]))
    expect((await raw.read(response, 0n)).status).toBe(401)
  })

  test('a request cannot reach the Noise routes from inside a channel', async () => {
    const { app, keys } = await setup()
    const raw = await rawChannel(app, keys)
    expect((await raw.read(await raw.post(raw.envelope(0n, '/noise/keys')), 0n)).status).toBe(404)
  })

  test('the client refuses a server that does not hold the pinned key', async () => {
    const { fetch } = await setup()
    const other = createServerKeys().keys
    await expect(openChannel({ fetch, baseUrl: 'http://localhost', serverKeys: other })).rejects.toThrow()
  })
})
