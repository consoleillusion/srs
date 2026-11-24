import { sha256 } from '@noble/hashes/sha2.js'
import { ed25519 } from '@noble/curves/ed25519.js'

/** A public Ed25519 key as a JSON Web Key. */
export type PublicJwk =
  { kty: 'OKP'
  , crv: 'Ed25519'
  , x: string
  }

/** A private Ed25519 key as a JSON Web Key. */
export type PrivateJwk =
  PublicJwk & { d: string }

/** An Ed25519 keypair; `secretKey` is the 32-byte seed. */
export type KeyPair =
  { publicJwk: PublicJwk
  , privateJwk: PrivateJwk
  , publicKey: Uint8Array
  , secretKey: Uint8Array
  }

/** Length of an Ed25519 seed (secret key) in bytes. */
export const ED25519_SEED_LENGTH = 32
/** Length of an Ed25519 public key in bytes. */
export const ED25519_PUBLIC_KEY_LENGTH = 32
/** Length of an Ed25519 signature in bytes. */
export const ED25519_SIGNATURE_LENGTH = 64

/**
 * Fill a new byte array from the platform's secure random source.
 * `crypto.getRandomValues` is available on plain-HTTP pages, unlike `crypto.subtle`.
 *
 * @param length - Number of bytes.
 */
export const randomBytes =
  (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length))

/**
 * Derive the Ed25519 public key for a 32-byte seed.
 *
 * @param seed - The secret key.
 */
export const ed25519PublicKey =
  (seed: Uint8Array): Uint8Array => ed25519.getPublicKey(seed)

/**
 * Sign a message with Ed25519 (RFC 8032).
 *
 * @param message - The bytes to sign.
 * @param seed - The 32-byte secret key.
 * @returns The 64-byte signature.
 */
export const ed25519Sign =
  (message: Uint8Array, seed: Uint8Array): Uint8Array => ed25519.sign(message, seed)

/**
 * Verify an Ed25519 signature with strict RFC 8032 rules, rejecting
 * non-canonical encodings so a signature has exactly one valid form.
 *
 * @param signature - The 64-byte signature.
 * @param message - The signed bytes.
 * @param publicKey - The 32-byte public key.
 * @returns Whether the signature is valid; never throws for malformed input.
 */
export const ed25519Verify =
  (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean => {
    if (signature.length !== ED25519_SIGNATURE_LENGTH
        || publicKey.length !== ED25519_PUBLIC_KEY_LENGTH)
      return false
    try {
      return ed25519.verify(signature, message, publicKey, { zip215: false })
    } catch {
      return false
    }
  }

/** Encodes bytes as unpadded base64url. */
export const bytesToBase64Url =
  (bytes: Uint8Array) => bytes.toBase64({ alphabet: 'base64url', omitPadding: true })

/**
 * Decodes unpadded base64url into bytes. Rejects anything that is not the
 * canonical encoding: other characters, padding, or non-zero trailing bits.
 */
export const base64UrlToBytes =
  (value: string) => {
    const bytes = Uint8Array.fromBase64(value, { alphabet: 'base64url' })
    if (bytesToBase64Url(bytes) !== value)
      throw new Error('Invalid base64url value')
    return bytes
  }

/**
 * Generates the fresh Ed25519 keypair used for one registration or login.
 */
export const generateKeyPair =
  (): KeyPair => {
    const secretKey = randomBytes(ED25519_SEED_LENGTH)
    const publicKey = ed25519PublicKey(secretKey)
    const publicJwk: PublicJwk =
      { kty: 'OKP'
      , crv: 'Ed25519'
      , x: bytesToBase64Url(publicKey)
      }
    const privateJwk: PrivateJwk =
      { ...publicJwk
      , d: bytesToBase64Url(secretKey)
      }

    return { publicJwk, privateJwk, publicKey, secretKey }
  }

const sha256Base64Url = (bytes: Uint8Array) => bytesToBase64Url(sha256(bytes))

export type SigningParts =
  { method: string
  , path: string
  , sessionId: string
  , timestamp: string
  , nonce: string
  , body: Uint8Array
  }

/**
 * Builds the exact bytes the server verifies for a signed request.
 */
export const signingMessage =
  (parts: SigningParts) => {
    const digest = sha256Base64Url(parts.body)
    return new TextEncoder().encode(
      [ 'srs-signature-v1'
      , parts.method.toUpperCase()
      , parts.path
      , parts.sessionId.toLowerCase()
      , parts.timestamp
      , parts.nonce
      , digest
      ].join('\n'))
  }

/**
 * Sign a request message with a session key.
 *
 * @param message - The bytes from {@link signingMessage}.
 * @param secretKey - The session's base64url Ed25519 seed.
 * @returns The base64url signature.
 */
export const sign =
  (message: Uint8Array, secretKey: string) =>
    bytesToBase64Url(ed25519Sign(message, base64UrlToBytes(secretKey)))

/** A fresh random nonce for one signed request. */
export const randomNonce = () => bytesToBase64Url(randomBytes(16))
