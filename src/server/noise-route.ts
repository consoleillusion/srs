import type { Hono } from 'hono'
import { bytesToHex } from '@noble/hashes/utils.js'
import
  { decodeRequest
  , encodeResponse
  , open
  , parseEnvelope
  , REQUEST_HEADERS
  , RESPONSE_HEADERS
  , seal
  , type SealedRequest
  } from '../protocol/envelope.ts'
import { errorDocument, jsonApi } from './app/document.ts'
import type { Channel, ChannelStore } from './channels.ts'
import { INNER, type AppContext, type Env, type InnerRequest } from './context.ts'
import { NOISE_MEDIA_TYPE } from './noise-handshake.ts'

/** Origin given to decrypted requests; never seen on the network. */
const INNER_ORIGIN = 'http://srs.channel'

/**
 * Check a decrypted request's signature, when the channel is logged in.
 * Returns what the inner request records about signing.
 */
export type SignatureCheck =
  (channel: Channel, request: SealedRequest, n: bigint) => Pick<InnerRequest, 'signed' | 'signature' | 'signedDigest'>

/**
 * Register `POST /noise`: open an envelope, check its counter, hand the
 * request inside to the app, and seal the app's response (design book,
 * Envelope).
 *
 * Failures before decryption answer in the clear without detail: `401` for an
 * unknown channel, `409` for a used counter, `400` for anything else.
 *
 * @param app - The app; decrypted requests are dispatched back into it.
 * @param options - The channel table, the client address function, and the signature check.
 */
export const registerEnvelopeRoute =
  ( app: Hono<Env>
  , options:
      { channels: ChannelStore
      , clientOf: (c: AppContext) => string
      , checkSignature: SignatureCheck
      }) => {
    const clear =
      (c: AppContext, status: 400 | 401 | 409, detail: string) =>
        jsonApi(c, errorDocument(status, status === 401 ? 'Unauthorized' : status === 409 ? 'Conflict' : 'Bad Request', detail), status)

    app.post('/noise', async c => {
      let envelope: ReturnType<typeof parseEnvelope>
      try {
        envelope = parseEnvelope(new Uint8Array(await c.req.arrayBuffer()))
      } catch {
        return clear(c, 400, 'Invalid envelope')
      }

      const channel = options.channels.get(envelope.sid)
      if (!channel) return clear(c, 401, 'Unknown or ended channel')
      if (!options.channels.fresh(channel, envelope.n)) return clear(c, 409, 'Counter already used')

      let request: SealedRequest
      try {
        request = decodeRequest(open(channel.clientToServer, channel.sid, envelope.n, envelope.ciphertext))
      } catch {
        // Not authenticated: the counter is not burned, so a forgery cannot use it up.
        return clear(c, 400, 'Invalid envelope')
      }
      options.channels.accept(channel, envelope.n)

      const reply =
        async (status: number, headers: [string, string][], body: Uint8Array) =>
          c.body(
            seal(channel.serverToClient, channel.sid, envelope.n
              , encodeResponse({ status, headers, body, signature: new Uint8Array(0) })).slice().buffer as ArrayBuffer
            , 200
            , { 'content-type': NOISE_MEDIA_TYPE, 'cache-control': 'no-store' })

      if (request.path.startsWith('/noise'))
        return reply(404, [], new Uint8Array(0))

      const signing = options.checkSignature(channel, request, envelope.n)
      const headers = new Headers()
      for (const [name, value] of request.headers)
        if ((REQUEST_HEADERS as readonly string[]).includes(name)) headers.set(name, value)
      const withBody = request.method !== 'GET' && request.method !== 'HEAD'
      const inner =
        new Request(
          INNER_ORIGIN + request.path
          , { method: request.method, headers, body: withBody ? request.body.slice() : undefined })
      const marker: InnerRequest = { channel, client: options.clientOf(c), ...signing }
      const response = await app.fetch(inner, { [INNER]: marker })

      const kept: [string, string][] = []
      for (const name of RESPONSE_HEADERS) {
        const value = response.headers.get(name)
        if (value !== null) kept.push([name, value])
      }
      return reply(response.status, kept, new Uint8Array(await response.arrayBuffer()))
    })
  }

/** Lowercase hex of a channel id, for logs and audit rows. */
export const channelLabel = (channel: Channel) => bytesToHex(channel.sid)
