/**
 * The client side of the Noise transport: fetch and check the server's key
 * bundle, run the handshake, and send requests through the channel (design
 * book, Transport). Pure JavaScript; works on plain-HTTP pages.
 *
 * @module
 */
import { hexToBytes } from '@noble/hashes/utils.js'
import { ProtocolError } from '../protocol/errors.ts'
import
  { decodeResponse
  , encodeRequest
  , open
  , parseEnvelope
  , seal
  } from '../protocol/envelope.ts'
import { initiator, type HandshakeResult } from '../protocol/noise.ts'
import { checkFingerprint, srsPrologue, type PublicServerKeys } from '../protocol/server-keys.ts'
import { base64UrlToBytes } from './crypto.ts'
import type { FetchLike } from './http.ts'

/** Media type of Noise handshake messages and envelopes. */
export const NOISE_MEDIA_TYPE = 'application/vnd.srs.noise'

/** A request to send through a channel. */
export type ChannelRequest =
  { method: string
  , path: string
  , headers?: [string, string][]
  , body?: Uint8Array
  /**
   * Called with the request counter and fields before sealing, to produce the
   * request signature; omit before login.
   */
  , sign?: (n: bigint, request: { method: string, path: string, contentType: string, body: Uint8Array }) => Uint8Array
  }

/** A response received through a channel. */
export interface ChannelResponse {
  /** The HTTP status the server's application answered with. */
  status: number
  /** The response headers that the channel carries. */
  headers: Map<string, string>
  /** The response body. */
  body: Uint8Array
  /**
   * Parse the body as JSON.
   *
   * @returns The parsed value, or undefined when the body is empty.
   */
  json<T = unknown>(): T | undefined
}

/** An open Noise channel to one server. */
export type Channel =
  { /** The 16-byte channel id. */
    sid: Uint8Array
  /** The handshake hash, bound into login and signatures. */
  , handshakeHash: Uint8Array
  /** Send one request; each gets a fresh counter. */
  , send: (request: ChannelRequest) => Promise<ChannelResponse>
  }

/** The reasons a channel operation fails, as {@link ProtocolError} codes. */
export type ChannelErrorCode =
  'fingerprint-mismatch' | 'handshake-failed' | 'channel-ended' | 'counter-rejected' | 'decrypt-failed'

/**
 * Fetch the server's key bundle and check it against the pinned fingerprint.
 *
 * @param fetchImpl - The fetch to use.
 * @param baseUrl - The server's base URL.
 * @param pinned - The `srs1:` fingerprint the client was configured with.
 * @throws {@link ProtocolError} `fingerprint-mismatch` when the server's keys differ.
 */
export const fetchServerKeys =
  async (fetchImpl: FetchLike, baseUrl: string, pinned: string): Promise<PublicServerKeys> => {
    const response = await fetchImpl(`${baseUrl}/noise/keys`)
    if (!response.ok) throw new ProtocolError('handshake-failed', `key bundle request failed: ${response.status}`)
    const body = await response.json() as { x25519?: unknown, ed25519?: unknown }
    if (typeof body.x25519 !== 'string' || typeof body.ed25519 !== 'string')
      throw new ProtocolError('handshake-failed', 'malformed key bundle')
    const keys = { x25519: base64UrlToBytes(body.x25519), ed25519: base64UrlToBytes(body.ed25519) }
    checkFingerprint(keys, pinned)
    return keys
  }

/**
 * Run the handshake and open a channel.
 *
 * @param options - The fetch to use, the server's base URL, and its checked public keys.
 * @throws {@link ProtocolError} `handshake-failed` when the server does not complete it.
 */
export const openChannel =
  async (options: { fetch: FetchLike, baseUrl: string, serverKeys: PublicServerKeys }): Promise<Channel> => {
    const handshake = initiator({ prologue: srsPrologue(options.serverKeys), responderStatic: options.serverKeys.x25519 })
    const response =
      await options.fetch(
        `${options.baseUrl}/noise/handshake`
        , { method: 'POST', headers: { 'content-type': NOISE_MEDIA_TYPE }
          , body: handshake.writeMessage1(new Uint8Array(0)).slice().buffer as ArrayBuffer })
    if (response.status !== 200) throw new ProtocolError('handshake-failed', `handshake answered ${response.status}`)

    let result: HandshakeResult
    let sid: Uint8Array
    try {
      const read = handshake.readMessage2(new Uint8Array(await response.arrayBuffer()))
      if (read.payload.length !== 16) throw new Error('channel id')
      sid = read.payload
      result = read.result
    } catch {
      throw new ProtocolError('handshake-failed', 'the server is not the pinned server')
    }

    let next = 0n
    return (
      { sid
      , handshakeHash: result.handshakeHash
      , send: async request => {
          const n = next++
          const body = request.body ?? new Uint8Array(0)
          const contentType = request.headers?.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ''
          const signature =
            request.sign?.(n, { method: request.method.toUpperCase(), path: request.path, contentType, body })
            ?? new Uint8Array(0)
          const envelope =
            seal(result.initiatorToResponder, sid, n
              , encodeRequest({ method: request.method, path: request.path, headers: request.headers ?? [], body, signature }))
          const reply =
            await options.fetch(
              `${options.baseUrl}/noise`
              , { method: 'POST', headers: { 'content-type': NOISE_MEDIA_TYPE }, body: envelope.slice().buffer as ArrayBuffer })
          if (reply.status === 401) throw new ProtocolError('channel-ended', 'the channel ended; open a new one')
          if (reply.status === 409) throw new ProtocolError('counter-rejected', 'the server refused the request counter')
          if (reply.status !== 200) throw new ProtocolError('decrypt-failed', `the server could not open the envelope (${reply.status})`)

          const parsed = parseEnvelope(new Uint8Array(await reply.arrayBuffer()))
          if (parsed.n !== n || parsed.sid.some((byte, i) => byte !== sid[i]))
            throw new ProtocolError('decrypt-failed', 'response belongs to another request')
          const decoded = decodeResponse(open(result.responderToInitiator, sid, n, parsed.ciphertext))
          const headers = new Map(decoded.headers)
          return (
            { status: decoded.status
            , headers
            , body: decoded.body
            , json: <T>() =>
                decoded.body.length === 0 ? undefined : JSON.parse(new TextDecoder().decode(decoded.body)) as T
            })
        }
      })
  }

export { hexToBytes }
