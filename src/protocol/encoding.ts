/**
 * Byte encodings shared by the client and the server: length-prefixed field
 * lists and the fixed layout of session certificates. Browser-safe: no Node
 * built-ins. Specified in the design book (Accounts and login, Signed
 * requests).
 *
 * @module
 */
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { ProtocolError } from './errors.ts'

export { bytesToHex, concatBytes, hexToBytes, utf8ToBytes }

/** Largest value a 64-bit unsigned field may hold. */
const U64_MAX = (1n << 64n) - 1n

/**
 * Encode an unsigned integer as 4 big-endian bytes.
 *
 * @param value - An integer from 0 to 2^32 - 1.
 * @throws {@link ProtocolError} `out-of-range` otherwise.
 */
export const u32be =
  (value: number): Uint8Array => {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
      throw new ProtocolError('out-of-range', `${value} does not fit in 32 bits`)
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, value)
    return bytes
  }

/**
 * Encode an unsigned integer as 8 big-endian bytes.
 *
 * @param value - An integer from 0 to 2^64 - 1.
 * @throws {@link ProtocolError} `out-of-range` otherwise.
 */
export const u64be =
  (value: number | bigint): Uint8Array => {
    if (typeof value === 'number' && !Number.isSafeInteger(value))
      throw new ProtocolError('out-of-range', `${value} is not a safe integer`)
    const big = BigInt(value)
    if (big < 0n || big > U64_MAX)
      throw new ProtocolError('out-of-range', `${value} does not fit in 64 bits`)
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setBigUint64(0, big)
    return bytes
  }

/**
 * Read an 8-byte big-endian unsigned integer.
 *
 * @param bytes - Exactly 8 bytes.
 */
export const readU64be =
  (bytes: Uint8Array): bigint => {
    if (bytes.length !== 8)
      throw new ProtocolError('invalid-length', 'a 64-bit field needs 8 bytes')
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0)
  }

/**
 * Join fields, each prefixed with its length as 4 big-endian bytes, so no
 * field can run into the next.
 *
 * @param fields - The fields, as bytes or UTF-8 text.
 */
export const lengthPrefixed =
  (...fields: (Uint8Array | string)[]): Uint8Array =>
    concatBytes(
      ...fields.flatMap(field => {
        const bytes = typeof field === 'string' ? utf8ToBytes(field) : field
        return [u32be(bytes.length), bytes]
      }))

/**
 * Check that a value is exactly the expected number of bytes.
 *
 * @param bytes - The value.
 * @param length - The required length.
 * @param name - The field name, for the error.
 * @throws {@link ProtocolError} `invalid-length` otherwise.
 */
export const exactly =
  (bytes: Uint8Array, length: number, name: string): Uint8Array => {
    if (bytes.length !== length)
      throw new ProtocolError('invalid-length', `${name} must be ${length} bytes, got ${bytes.length}`)
    return bytes
  }

/** The fields of a session certificate (design book, Session certificates). */
export type Certificate =
  { /** The user, 16 bytes. */
    userId: Uint8Array
  /** The login record, 16 bytes. */
  , loginId: Uint8Array
  /** The channel id, 16 bytes. */
  , sid: Uint8Array
  /** The channel's handshake hash, 32 bytes. */
  , h: Uint8Array
  /** The session's Ed25519 public key, 32 bytes. */
  , sessionPublic: Uint8Array
  /** Milliseconds since the epoch. */
  , issuedAt: number
  /** Milliseconds since the epoch. */
  , expiresAt: number
  }

/** The domain tag that starts every encoded certificate. */
export const CERTIFICATE_TAG = 'srs-cert-v1'

/** Length of an encoded certificate in bytes. */
export const CERTIFICATE_LENGTH = CERTIFICATE_TAG.length + 16 * 3 + 32 * 2 + 8 * 2

/**
 * Encode a certificate in its fixed layout; these are the bytes the identity
 * key signs.
 *
 * @param cert - The certificate.
 * @throws {@link ProtocolError} when a field has the wrong length or range.
 */
export const encodeCertificate =
  (cert: Certificate): Uint8Array => {
    if (cert.expiresAt <= cert.issuedAt)
      throw new ProtocolError('invalid-certificate', 'expiresAt must be after issuedAt')
    return concatBytes(
      utf8ToBytes(CERTIFICATE_TAG)
      , exactly(cert.userId, 16, 'userId')
      , exactly(cert.loginId, 16, 'loginId')
      , exactly(cert.sid, 16, 'sid')
      , exactly(cert.h, 32, 'h')
      , exactly(cert.sessionPublic, 32, 'sessionPublic')
      , u64be(cert.issuedAt)
      , u64be(cert.expiresAt))
  }

/**
 * Decode a certificate from its fixed layout.
 *
 * @param bytes - Exactly {@link CERTIFICATE_LENGTH} bytes.
 * @throws {@link ProtocolError} `invalid-certificate` when the layout or tag is wrong.
 */
export const decodeCertificate =
  (bytes: Uint8Array): Certificate => {
    const tag = utf8ToBytes(CERTIFICATE_TAG)
    if (bytes.length !== CERTIFICATE_LENGTH
        || bytesToHex(bytes.subarray(0, tag.length)) !== bytesToHex(tag))
      throw new ProtocolError('invalid-certificate', 'not a version 1 certificate')
    let at = tag.length
    const take = (length: number) => bytes.slice(at, (at += length))
    const cert =
      { userId: take(16), loginId: take(16), sid: take(16), h: take(32), sessionPublic: take(32)
      , issuedAt: Number(readU64be(take(8))), expiresAt: Number(readU64be(take(8)))
      }
    if (!Number.isSafeInteger(cert.issuedAt) || !Number.isSafeInteger(cert.expiresAt)
        || cert.expiresAt <= cert.issuedAt)
      throw new ProtocolError('invalid-certificate', 'invalid certificate times')
    return cert
  }
