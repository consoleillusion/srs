/**
 * The Noise envelope and the request and response it carries (design book,
 * Envelope). Browser-safe; used by both the client and the server.
 *
 * @module
 */
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { exactly, lengthPrefixed, readU64be, splitLengthPrefixed, u64be } from './encoding.ts'
import { ProtocolError } from './errors.ts'
import { decryptWithNonce, encryptWithNonce } from './noise.ts'

/** The 4-byte magic that starts every envelope. */
export const ENVELOPE_MAGIC = 'SRS1'
/** Bytes before the ciphertext: magic, channel id and counter. */
export const ENVELOPE_HEADER_LENGTH = 4 + 16 + 8
/** Length of an Ed25519 signature. */
export const SIGNATURE_LENGTH = 64

/** Request headers carried inside the channel; all others are dropped. */
export const REQUEST_HEADERS = ['accept', 'content-type', 'x-request-id'] as const
/** Response headers carried inside the channel; all others are dropped. */
export const RESPONSE_HEADERS =
  ['allow', 'content-type', 'location', 'retry-after', 'x-request-id'] as const

/** An HTTP request as carried inside an envelope. */
export type SealedRequest =
  { method: string
  , path: string
  , headers: [string, string][]
  , body: Uint8Array
  /** The request signature, or empty before login. */
  , signature: Uint8Array
  }

/** An HTTP response as carried inside an envelope. */
export type SealedResponse =
  { status: number
  , headers: [string, string][]
  , body: Uint8Array
  /** The server's response signature, or empty when responses are not signed. */
  , signature: Uint8Array
  }

/** The associated data of an envelope: its magic, channel id and counter. */
export const envelopeAd =
  (sid: Uint8Array, n: bigint): Uint8Array =>
    concatBytes(utf8ToBytes(ENVELOPE_MAGIC), exactly(sid, 16, 'sid'), u64be(n))

/**
 * Split an envelope into its channel id, counter and ciphertext.
 *
 * @param bytes - The envelope.
 * @throws {@link ProtocolError} `invalid-envelope` when it is malformed.
 */
export const parseEnvelope =
  (bytes: Uint8Array): { sid: Uint8Array, n: bigint, ciphertext: Uint8Array } => {
    if (bytes.length < ENVELOPE_HEADER_LENGTH + 16
        || new TextDecoder().decode(bytes.subarray(0, 4)) !== ENVELOPE_MAGIC)
      throw new ProtocolError('invalid-envelope', 'not an SRS1 envelope')
    return (
      { sid: bytes.slice(4, 20)
      , n: readU64be(bytes.slice(20, 28))
      , ciphertext: bytes.slice(28)
      })
  }

/**
 * Encrypt a payload into an envelope.
 *
 * @param key - The direction's transport key.
 * @param sid - The channel id.
 * @param n - The request counter.
 * @param plaintext - The encoded request or response.
 */
export const seal =
  (key: Uint8Array, sid: Uint8Array, n: bigint, plaintext: Uint8Array): Uint8Array => {
    const ad = envelopeAd(sid, n)
    return concatBytes(ad, encryptWithNonce(key, n, ad, plaintext))
  }

/**
 * Decrypt an envelope's ciphertext.
 *
 * @param key - The direction's transport key.
 * @param sid - The channel id.
 * @param n - The counter from the envelope.
 * @param ciphertext - The ciphertext from the envelope.
 * @throws {@link ProtocolError} `decrypt-failed` when it does not authenticate.
 */
export const open =
  (key: Uint8Array, sid: Uint8Array, n: bigint, ciphertext: Uint8Array): Uint8Array =>
    decryptWithNonce(key, n, envelopeAd(sid, n), ciphertext)

/** Encode header pairs as alternating length-prefixed names and values. */
const encodeHeaders =
  (headers: [string, string][]): Uint8Array =>
    lengthPrefixed(...headers.flatMap(([name, value]) => [name.toLowerCase(), value]))

/** Decode header pairs. */
const decodeHeaders =
  (bytes: Uint8Array): [string, string][] => {
    let count = 0
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let at = 0; at < bytes.length; count++) {
      if (at + 4 > bytes.length) throw new ProtocolError('invalid-encoding', 'truncated header')
      at += 4 + view.getUint32(at)
    }
    if (count % 2 !== 0) throw new ProtocolError('invalid-encoding', 'header without a value')
    const fields = splitLengthPrefixed(bytes, count).map(x => new TextDecoder().decode(x))
    const pairs: [string, string][] = []
    for (let i = 0; i < fields.length; i += 2) pairs.push([fields[i]!, fields[i + 1]!])
    return pairs
  }

/**
 * Encode a request: method, path, headers, body and signature as
 * length-prefixed fields.
 *
 * @param request - The request.
 */
export const encodeRequest =
  (request: SealedRequest): Uint8Array =>
    lengthPrefixed(
      request.method.toUpperCase(), request.path, encodeHeaders(request.headers)
      , request.body, request.signature)

/**
 * Decode a request.
 *
 * @param bytes - The decrypted plaintext.
 * @throws {@link ProtocolError} `invalid-encoding` when it is malformed.
 */
export const decodeRequest =
  (bytes: Uint8Array): SealedRequest => {
    const [method, path, headers, body, signature] = splitLengthPrefixed(bytes, 5) as
      [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array]
    const text = (x: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(x)
    let decoded: SealedRequest
    try {
      decoded = { method: text(method), path: text(path), headers: decodeHeaders(headers), body, signature }
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      throw new ProtocolError('invalid-encoding', 'request text is not UTF-8')
    }
    if (!/^[A-Z]{1,10}$/.test(decoded.method) || !decoded.path.startsWith('/'))
      throw new ProtocolError('invalid-encoding', 'invalid method or path')
    if (signature.length !== 0 && signature.length !== SIGNATURE_LENGTH)
      throw new ProtocolError('invalid-encoding', 'invalid signature length')
    return decoded
  }

/**
 * Encode a response: status, headers, body and signature as length-prefixed
 * fields; the status as three ASCII digits.
 *
 * @param response - The response.
 */
export const encodeResponse =
  (response: SealedResponse): Uint8Array =>
    lengthPrefixed(
      String(response.status).padStart(3, '0'), encodeHeaders(response.headers)
      , response.body, response.signature)

/**
 * Decode a response.
 *
 * @param bytes - The decrypted plaintext.
 * @throws {@link ProtocolError} `invalid-encoding` when it is malformed.
 */
export const decodeResponse =
  (bytes: Uint8Array): SealedResponse => {
    const [status, headers, body, signature] = splitLengthPrefixed(bytes, 4) as
      [Uint8Array, Uint8Array, Uint8Array, Uint8Array]
    const code = new TextDecoder().decode(status)
    if (!/^[1-5][0-9]{2}$/.test(code)) throw new ProtocolError('invalid-encoding', 'invalid status')
    return { status: Number(code), headers: decodeHeaders(headers), body, signature }
  }
