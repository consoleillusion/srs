/**
 * The account protocol's messages: the registration proof, the login binder,
 * identity-key wrapping, session certificates and request signatures (design
 * book, Accounts and login; Signed requests). Browser-safe; shared by the
 * client and the server so both build exactly the same bytes.
 *
 * @module
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { ed25519PublicKey, ed25519Sign, ed25519Verify } from '../client/crypto.ts'
import { encodeCertificate, exactly, lengthPrefixed, u64be, type Certificate } from './encoding.ts'
import { ProtocolError } from './errors.ts'

/** Length of an XChaCha20-Poly1305 nonce. */
export const WRAP_NONCE_LENGTH = 24
/** Length of a wrapped identity key: nonce, 32-byte key, 16-byte tag. */
export const WRAPPED_IDENTITY_LENGTH = WRAP_NONCE_LENGTH + 32 + 16

/**
 * Constant-time equality of two byte strings.
 *
 * @param a - First value.
 * @param b - Second value.
 */
export const equalBytes =
  (a: Uint8Array, b: Uint8Array): boolean => {
    let diff = a.length ^ b.length
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
    return diff === 0
  }

/**
 * The bytes an identity key signs to prove possession at registration.
 *
 * @param h - The channel's handshake hash.
 * @param userId - The new user's 16-byte id.
 * @param username - The username, lowercased.
 * @param identityPublic - The identity public key.
 */
export const registrationProofMessage =
  (h: Uint8Array, userId: Uint8Array, username: string, identityPublic: Uint8Array): Uint8Array =>
    lengthPrefixed(
      'srs-register-v1', exactly(h, 32, 'h'), exactly(userId, 16, 'userId'), username
      , exactly(identityPublic, 32, 'identityPublic'))

/**
 * The login binder: an HMAC of the channel under the OPAQUE session key, proving
 * the login ran in this channel.
 *
 * @param sessionKey - The OPAQUE session key.
 * @param h - The channel's handshake hash.
 * @param sid - The channel id.
 */
export const loginBinder =
  (sessionKey: Uint8Array, h: Uint8Array, sid: Uint8Array): Uint8Array =>
    hmac(sha256, sessionKey, concatBytes(utf8ToBytes('srs-bind-v1'), exactly(h, 32, 'h'), exactly(sid, 16, 'sid')))

/**
 * Derive the key that wraps the identity key from the OPAQUE export key.
 *
 * @param exportKey - The OPAQUE export key.
 */
export const wrapKey =
  (exportKey: Uint8Array): Uint8Array =>
    hkdf(sha256, exportKey, new Uint8Array(0), utf8ToBytes('srs-identity-wrap-v1'), 32)

/** The associated data that ties a wrapped key to its user and public key. */
const wrapAd =
  (userId: Uint8Array, identityPublic: Uint8Array) =>
    concatBytes(exactly(userId, 16, 'userId'), exactly(identityPublic, 32, 'identityPublic'))

/**
 * Encrypt an identity key under the OPAQUE export key.
 *
 * @param options - The export key, the user id, the identity keypair, and the 24-byte nonce.
 * @returns The nonce followed by the ciphertext.
 */
export const wrapIdentity =
  (options:
    { exportKey: Uint8Array, userId: Uint8Array, identityPublic: Uint8Array
    , identityPrivate: Uint8Array, nonce: Uint8Array }): Uint8Array => {
    const nonce = exactly(options.nonce, WRAP_NONCE_LENGTH, 'nonce')
    const ciphertext =
      xchacha20poly1305(wrapKey(options.exportKey), nonce, wrapAd(options.userId, options.identityPublic))
        .encrypt(exactly(options.identityPrivate, 32, 'identityPrivate'))
    return concatBytes(nonce, ciphertext)
  }

/**
 * Decrypt an identity key and check it matches its public key.
 *
 * @param options - The export key, user id, identity public key and wrapped key.
 * @throws {@link ProtocolError} `unwrap-failed` when the password or data is wrong.
 */
export const unwrapIdentity =
  (options: { exportKey: Uint8Array, userId: Uint8Array, identityPublic: Uint8Array, wrapped: Uint8Array }): Uint8Array => {
    if (options.wrapped.length !== WRAPPED_IDENTITY_LENGTH)
      throw new ProtocolError('unwrap-failed', 'wrapped identity key has the wrong length')
    let identityPrivate: Uint8Array
    try {
      identityPrivate =
        xchacha20poly1305(
          wrapKey(options.exportKey), options.wrapped.subarray(0, WRAP_NONCE_LENGTH)
          , wrapAd(options.userId, options.identityPublic))
          .decrypt(options.wrapped.subarray(WRAP_NONCE_LENGTH))
    } catch {
      throw new ProtocolError('unwrap-failed', 'the identity key could not be unwrapped')
    }
    if (!equalBytes(ed25519PublicKey(identityPrivate), options.identityPublic))
      throw new ProtocolError('unwrap-failed', 'the identity key does not match its public key')
    return identityPrivate
  }

/**
 * Sign a session certificate with the identity key.
 *
 * @param identityPrivate - The identity key.
 * @param cert - The certificate.
 * @returns The encoded certificate and its signature.
 */
export const signCertificate =
  (identityPrivate: Uint8Array, cert: Certificate): { certificate: Uint8Array, signature: Uint8Array } => {
    const certificate = encodeCertificate(cert)
    return { certificate, signature: ed25519Sign(certificate, identityPrivate) }
  }

/**
 * Check a certificate's signature.
 *
 * @param identityPublic - The identity public key.
 * @param certificate - The encoded certificate.
 * @param signature - Its signature.
 */
export const verifyCertificate =
  (identityPublic: Uint8Array, certificate: Uint8Array, signature: Uint8Array): boolean =>
    ed25519Verify(signature, certificate, identityPublic)

/** The parts of a request covered by its signature. */
export type SignedRequestParts =
  { h: Uint8Array
  , sid: Uint8Array
  , n: bigint
  , method: string
  , path: string
  , contentType: string
  , body: Uint8Array
  }

/**
 * The bytes a session key signs for one request. Every field is
 * length-prefixed; the body is covered by its SHA-256 hash.
 *
 * @param parts - The request and its channel position.
 */
export const requestMessage =
  (parts: SignedRequestParts): Uint8Array =>
    lengthPrefixed(
      'srs-req-v1', exactly(parts.h, 32, 'h'), exactly(parts.sid, 16, 'sid'), u64be(parts.n)
      , parts.method.toUpperCase(), parts.path, parts.contentType, sha256(parts.body))
