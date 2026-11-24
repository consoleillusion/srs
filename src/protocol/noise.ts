/**
 * The Noise NK handshake, `Noise_NK_25519_ChaChaPoly_BLAKE2s`, written from the
 * Noise Protocol Framework specification (revision 34) on audited primitives
 * from `@noble`. Browser-safe. Checked against the published test vectors.
 *
 * NK: the initiator (client) knows the responder's (server's) static key in
 * advance and has none of its own.
 *
 * ```text
 * NK:
 *   <- s
 *   ...
 *   -> e, es
 *   <- e, ee
 * ```
 *
 * See the design book, Transport.
 *
 * @module
 */
import { x25519 } from '@noble/curves/ed25519.js'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { blake2s } from '@noble/hashes/blake2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { ProtocolError } from './errors.ts'

/** The protocol name, hashed into the initial handshake state. */
export const PROTOCOL_NAME = 'Noise_NK_25519_ChaChaPoly_BLAKE2s'

const HASHLEN = 32
const DHLEN = 32
const TAGLEN = 16

/** Largest nonce a cipher key may use; the Noise specification reserves 2^64 - 1. */
export const MAX_NONCE = (1n << 64n) - 2n

/** An X25519 keypair. */
export type KeyPair = { privateKey: Uint8Array, publicKey: Uint8Array }

/**
 * Build an X25519 keypair from a 32-byte private key.
 *
 * @param privateKey - The private key.
 */
export const keyPairFromPrivate =
  (privateKey: Uint8Array): KeyPair => ({ privateKey, publicKey: x25519.getPublicKey(privateKey) })

/** Generate a fresh X25519 keypair. */
export const generateKeyPair =
  (): KeyPair => keyPairFromPrivate(x25519.utils.randomSecretKey())

/** X25519, rejecting an all-zero result (a low-order public key). */
const dh =
  (keyPair: KeyPair, publicKey: Uint8Array): Uint8Array => {
    let shared: Uint8Array
    try {
      shared = x25519.getSharedSecret(keyPair.privateKey, publicKey)
    } catch {
      throw new ProtocolError('invalid-key', 'invalid X25519 public key')
    }
    if (shared.every(byte => byte === 0))
      throw new ProtocolError('invalid-key', 'low-order X25519 public key')
    return shared
  }

/** The Noise ChaChaPoly nonce: 32 zero bits, then the 64-bit counter, little-endian. */
const chachaNonce =
  (n: bigint): Uint8Array => {
    if (n < 0n || n > MAX_NONCE) throw new ProtocolError('nonce-exhausted', 'cipher nonce out of range')
    const nonce = new Uint8Array(12)
    new DataView(nonce.buffer).setBigUint64(4, n, true)
    return nonce
  }

/**
 * ChaCha20-Poly1305 encryption with an explicit Noise nonce.
 *
 * @param key - 32-byte key.
 * @param n - The nonce counter.
 * @param ad - Associated data.
 * @param plaintext - The message.
 */
export const encryptWithNonce =
  (key: Uint8Array, n: bigint, ad: Uint8Array, plaintext: Uint8Array): Uint8Array =>
    chacha20poly1305(key, chachaNonce(n), ad).encrypt(plaintext)

/**
 * ChaCha20-Poly1305 decryption with an explicit Noise nonce.
 *
 * @param key - 32-byte key.
 * @param n - The nonce counter.
 * @param ad - Associated data.
 * @param ciphertext - The message and its 16-byte tag.
 * @throws {@link ProtocolError} `decrypt-failed` when authentication fails.
 */
export const decryptWithNonce =
  (key: Uint8Array, n: bigint, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array => {
    try {
      return chacha20poly1305(key, chachaNonce(n), ad).decrypt(ciphertext)
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      throw new ProtocolError('decrypt-failed', 'message authentication failed')
    }
  }

/** Noise HKDF: HMAC-BLAKE2s based, returning two or three 32-byte outputs. */
const hkdf =
  (chainingKey: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] => {
    const temp = hmac(blake2s, chainingKey, ikm)
    const out1 = hmac(blake2s, temp, Uint8Array.of(1))
    const out2 = hmac(blake2s, temp, concatBytes(out1, Uint8Array.of(2)))
    return [out1, out2]
  }

/** A Noise CipherState used during the handshake (implicit nonces). */
class CipherState {
  k: Uint8Array | undefined
  n = 0n

  initializeKey(key: Uint8Array) {
    this.k = key
    this.n = 0n
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array) {
    if (!this.k) return plaintext
    const out = encryptWithNonce(this.k, this.n, ad, plaintext)
    this.n += 1n
    return out
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array) {
    if (!this.k) return ciphertext
    const out = decryptWithNonce(this.k, this.n, ad, ciphertext)
    this.n += 1n
    return out
  }
}

/** A Noise SymmetricState. */
class SymmetricState {
  ck: Uint8Array
  h: Uint8Array
  cipher = new CipherState()

  constructor(protocolName: string) {
    const name = utf8ToBytes(protocolName)
    this.h = name.length <= HASHLEN ? concatBytes(name, new Uint8Array(HASHLEN - name.length)) : blake2s(name)
    this.ck = this.h
  }

  mixKey(ikm: Uint8Array) {
    const [ck, k] = hkdf(this.ck, ikm)
    this.ck = ck
    this.cipher.initializeKey(k)
  }

  mixHash(data: Uint8Array) {
    this.h = blake2s(concatBytes(this.h, data))
  }

  encryptAndHash(plaintext: Uint8Array) {
    const ciphertext = this.cipher.encryptWithAd(this.h, plaintext)
    this.mixHash(ciphertext)
    return ciphertext
  }

  decryptAndHash(ciphertext: Uint8Array) {
    const plaintext = this.cipher.decryptWithAd(this.h, ciphertext)
    this.mixHash(ciphertext)
    return plaintext
  }

  split(): [Uint8Array, Uint8Array] {
    return hkdf(this.ck, new Uint8Array(0))
  }
}

/** What a finished handshake gives each side. */
export type HandshakeResult =
  { /** Key for messages from initiator (client) to responder (server). */
    initiatorToResponder: Uint8Array
  /** Key for messages from responder to initiator. */
  , responderToInitiator: Uint8Array
  /** The handshake hash; identifies the channel. */
  , handshakeHash: Uint8Array
  }

/** A handshake from the initiator's side. */
export type Initiator =
  { /** Write message 1 (`e, es`) carrying a payload. */
    writeMessage1: (payload: Uint8Array) => Uint8Array
  /** Read message 2 (`e, ee`), returning its payload and the session keys. */
  , readMessage2: (message: Uint8Array) => { payload: Uint8Array, result: HandshakeResult }
  }

/** A handshake from the responder's side. */
export type Responder =
  { /** Read message 1, returning its payload. */
    readMessage1: (message: Uint8Array) => Uint8Array
  /** Write message 2 carrying a payload, returning it and the session keys. */
  , writeMessage2: (payload: Uint8Array) => { message: Uint8Array, result: HandshakeResult }
  }

const start =
  (prologue: Uint8Array, responderStatic: Uint8Array) => {
    const state = new SymmetricState(PROTOCOL_NAME)
    state.mixHash(prologue)
    state.mixHash(responderStatic)
    return state
  }

const finish =
  (state: SymmetricState): HandshakeResult => {
    const [initiatorToResponder, responderToInitiator] = state.split()
    return { initiatorToResponder, responderToInitiator, handshakeHash: state.h }
  }

/**
 * Begin an NK handshake as the initiator.
 *
 * @param options - The prologue, the responder's pinned static public key, and
 *   optionally a fixed ephemeral key (tests only).
 */
export const initiator =
  (options: { prologue: Uint8Array, responderStatic: Uint8Array, ephemeral?: KeyPair }): Initiator => {
    if (options.responderStatic.length !== DHLEN)
      throw new ProtocolError('invalid-length', 'responder static key must be 32 bytes')
    const state = start(options.prologue, options.responderStatic)
    const e = options.ephemeral ?? generateKeyPair()
    let step = 0

    return (
      { writeMessage1: payload => {
          if (step++ !== 0) throw new ProtocolError('out-of-order', 'message 1 already written')
          state.mixHash(e.publicKey)
          state.mixKey(dh(e, options.responderStatic))
          return concatBytes(e.publicKey, state.encryptAndHash(payload))
        }
      , readMessage2: message => {
          if (step++ !== 1) throw new ProtocolError('out-of-order', 'message 2 read out of order')
          if (message.length < DHLEN + TAGLEN)
            throw new ProtocolError('invalid-length', 'handshake message 2 is too short')
          const re = message.slice(0, DHLEN)
          state.mixHash(re)
          state.mixKey(dh(e, re))
          const payload = state.decryptAndHash(message.slice(DHLEN))
          return { payload, result: finish(state) }
        }
      })
  }

/**
 * Begin an NK handshake as the responder.
 *
 * @param options - The prologue, the responder's static keypair, and
 *   optionally a fixed ephemeral key (tests only).
 */
export const responder =
  (options: { prologue: Uint8Array, staticKey: KeyPair, ephemeral?: KeyPair }): Responder => {
    const state = start(options.prologue, options.staticKey.publicKey)
    const e = options.ephemeral ?? generateKeyPair()
    let re: Uint8Array | undefined
    let step = 0

    return (
      { readMessage1: message => {
          if (step++ !== 0) throw new ProtocolError('out-of-order', 'message 1 already read')
          if (message.length < DHLEN + TAGLEN)
            throw new ProtocolError('invalid-length', 'handshake message 1 is too short')
          re = message.slice(0, DHLEN)
          state.mixHash(re)
          state.mixKey(dh(options.staticKey, re))
          return state.decryptAndHash(message.slice(DHLEN))
        }
      , writeMessage2: payload => {
          if (step++ !== 1 || !re) throw new ProtocolError('out-of-order', 'message 2 written out of order')
          state.mixHash(e.publicKey)
          state.mixKey(dh(e, re))
          const message = concatBytes(e.publicKey, state.encryptAndHash(payload))
          return { message, result: finish(state) }
        }
      })
  }
