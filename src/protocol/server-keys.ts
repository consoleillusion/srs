/**
 * The server key bundle and its fingerprint (design book, Server keys).
 * Browser-safe: the client uses it to check a fetched bundle against its pin.
 *
 * @module
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { ProtocolError } from './errors.ts'

/** Domain tag of the fingerprint hash. */
export const FINGERPRINT_TAG = 'srs-keys-v1'
/** Prefix of a printed fingerprint. */
export const FINGERPRINT_PREFIX = 'srs1:'

/** The public half of the server key bundle. */
export type PublicServerKeys =
  { /** X25519 static key for Noise, 32 bytes. */
    x25519: Uint8Array
  /** Ed25519 signing key, 32 bytes. */
  , ed25519: Uint8Array
  }

/** The full server key bundle, held only by the server. */
export type ServerKeys =
  PublicServerKeys &
  { /** X25519 private key, 32 bytes. */
    x25519Private: Uint8Array
  /** Ed25519 seed, 32 bytes. */
  , ed25519Private: Uint8Array
  /** The `srs1:` fingerprint clients pin. */
  , fingerprint: string
  }

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/**
 * Encode bytes as lowercase RFC 4648 base32 without padding.
 *
 * @param bytes - The bytes to encode.
 */
export const base32 =
  (bytes: Uint8Array): string => {
    let out = ''
    let buffer = 0
    let bits = 0
    for (const byte of bytes) {
      buffer = (buffer << 8) | byte
      bits += 8
      while (bits >= 5) {
        out += BASE32[(buffer >>> (bits - 5)) & 31]
        bits -= 5
      }
    }
    if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31]
    return out
  }

/**
 * Compute the fingerprint clients pin: `srs1:` and the base32 SHA-256 of the
 * tag and both public keys.
 *
 * @param keys - The public keys.
 * @throws {@link ProtocolError} `invalid-length` when a key is not 32 bytes.
 */
export const fingerprint =
  (keys: PublicServerKeys): string =>
    FINGERPRINT_PREFIX + base32(fingerprintDigest(keys))

/**
 * The 32-byte SHA-256 digest behind the fingerprint.
 *
 * @param keys - The public keys.
 * @throws {@link ProtocolError} `invalid-length` when a key is not 32 bytes.
 */
export const fingerprintDigest =
  (keys: PublicServerKeys): Uint8Array => {
    if (keys.x25519.length !== 32 || keys.ed25519.length !== 32)
      throw new ProtocolError('invalid-length', 'server public keys are 32 bytes each')
    return sha256(concatBytes(utf8ToBytes(FINGERPRINT_TAG), keys.x25519, keys.ed25519))
  }

/** The ASCII tag that starts the Noise prologue. */
export const PROLOGUE_TAG = 'srs-noise-v1'

/**
 * The Noise prologue for a server: `srs-noise-v1` and the fingerprint digest,
 * so a handshake only completes against the pinned key bundle.
 *
 * @param keys - The server's public keys.
 */
export const srsPrologue =
  (keys: PublicServerKeys): Uint8Array =>
    concatBytes(utf8ToBytes(PROLOGUE_TAG), fingerprintDigest(keys))

/**
 * Check a fetched bundle against a pinned fingerprint, in constant time.
 *
 * @param keys - The bundle as served by `GET /noise/keys`.
 * @param pinned - The fingerprint the client was configured with.
 * @throws {@link ProtocolError} `fingerprint-mismatch` when they differ.
 */
export const checkFingerprint =
  (keys: PublicServerKeys, pinned: string): void => {
    const actual = utf8ToBytes(fingerprint(keys))
    const expected = utf8ToBytes(pinned.trim().toLowerCase())
    let diff = actual.length ^ expected.length
    for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ (expected[i] ?? 0)
    if (diff !== 0)
      throw new ProtocolError('fingerprint-mismatch', 'the server key does not match the pinned fingerprint')
  }

/**
 * Derive the full bundle from its 64 secret bytes (X25519 private key, then
 * Ed25519 seed).
 *
 * @param secret - 64 bytes.
 * @throws {@link ProtocolError} `invalid-length` otherwise.
 */
export const serverKeysFromSecret =
  (secret: Uint8Array): ServerKeys => {
    if (secret.length !== 64)
      throw new ProtocolError('invalid-length', 'the server key secret is 64 bytes')
    const x25519Private = secret.slice(0, 32)
    const ed25519Private = secret.slice(32)
    const keys =
      { x25519: x25519.getPublicKey(x25519Private), ed25519: ed25519.getPublicKey(ed25519Private) }
    return { ...keys, x25519Private, ed25519Private, fingerprint: fingerprint(keys) }
  }

/** Render bytes as lowercase hex (re-exported for callers of this module). */
export { bytesToHex }
