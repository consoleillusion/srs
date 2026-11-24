import { ED25519_PUBLIC_KEY_LENGTH, ED25519_SEED_LENGTH, ed25519PublicKey, generateKeyPair as generateClientKeyPair } from '../client/crypto.ts'

export type PublicJwk =
  { kty: 'OKP'
  , crv: 'Ed25519'
  , x: string
  }

export type PrivateJwk =
  PublicJwk & { d: string }

const base64Url =
  (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')

const fromBase64Url =
  (value: string) => Buffer.from(value, 'base64url')

import { isObject } from '../server/guard.ts'

/** Generate a fresh Ed25519 keypair; `secretKey` is the 32-byte seed. */
export const generateKeyPair = generateClientKeyPair

export const parsePublicJwk =
  (value: unknown): PublicJwk => {
    if (!isObject(value)
        || value.kty !== 'OKP'
        || value.crv !== 'Ed25519'
        || typeof value.x !== 'string'
        || value.x.length === 0
        || value.d !== undefined)
      throw new Error('Expected an Ed25519 public JWK')

    const key = fromBase64Url(value.x)
    if (key.length !== ED25519_PUBLIC_KEY_LENGTH)
      throw new Error('Ed25519 public key has an invalid length')

    return { kty: 'OKP', crv: 'Ed25519', x: value.x }
  }

export const parsePrivateJwk =
  (value: unknown): PrivateJwk => {
    if (!isObject(value)
        || value.kty !== 'OKP'
        || value.crv !== 'Ed25519'
        || typeof value.x !== 'string'
        || typeof value.d !== 'string')
      throw new Error('Expected an Ed25519 private JWK')

    const seed = fromBase64Url(value.d)
    if (seed.length !== ED25519_SEED_LENGTH)
      throw new Error('Ed25519 private key has an invalid length')

    if (base64Url(ed25519PublicKey(seed)) !== value.x)
      throw new Error('Ed25519 private JWK does not match its public key')

    return { kty: 'OKP', crv: 'Ed25519', x: value.x, d: value.d }
  }

export const publicJwkFromPrivate =
  (value: unknown): PublicJwk => {
    const privateJwk = parsePrivateJwk(value)
    return { kty: 'OKP', crv: 'Ed25519', x: privateJwk.x }
  }
