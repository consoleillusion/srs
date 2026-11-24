import { randomBytes } from '../client/crypto.ts'
import { ProtocolError } from '../protocol/errors.ts'
import { serverKeysFromSecret, transitionMessage, type ServerKeys } from '../protocol/server-keys.ts'
import { ed25519Sign } from '../client/crypto.ts'

/** Prefix of the `SRS_SERVER_KEYS` setting, naming its format. */
export const SERVER_KEYS_SETTING_PREFIX = 'srs-keys-v1:'

/**
 * Create a new server key bundle and the setting value that stores it.
 *
 * @returns The keys and the value to put in `SRS_SERVER_KEYS`.
 */
export const createServerKeys =
  (): { keys: ServerKeys, setting: string } => {
    const secret = randomBytes(64)
    return (
      { keys: serverKeysFromSecret(secret)
      , setting: SERVER_KEYS_SETTING_PREFIX + Buffer.from(secret).toString('base64url')
      })
  }

/**
 * Read the server key bundle from the `SRS_SERVER_KEYS` setting.
 *
 * @param setting - The setting value.
 * @throws When the value is malformed; the message names the setting, never the value.
 */
export const parseServerKeys =
  (setting: string): ServerKeys => {
    if (!setting.startsWith(SERVER_KEYS_SETTING_PREFIX))
      throw new Error(`SRS_SERVER_KEYS must start with "${SERVER_KEYS_SETTING_PREFIX}"`)
    const secret = Buffer.from(setting.slice(SERVER_KEYS_SETTING_PREFIX.length), 'base64url')
    try {
      return serverKeysFromSecret(new Uint8Array(secret))
    } catch (error) {
      if (error instanceof ProtocolError) throw new Error('SRS_SERVER_KEYS is not a valid key bundle')
      throw error
    }
  }

/**
 * The public bundle as `GET /noise/keys` serves it.
 *
 * @param keys - The server's keys.
 * @param rotation - The previous bundle and transition, during a key rotation.
 * @param now - The current time.
 */
export const publicBundle =
  (keys: ServerKeys, rotation?: { previous: ServerKeys, transition: KeyTransition }, now = Date.now()) => {
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
    return (
      { version: 1
      , x25519: b64(keys.x25519)
      , ed25519: b64(keys.ed25519)
      , fingerprint: keys.fingerprint
      // While the old keys still work, clients pinned to them can follow the signed statement.
      , ...(rotation && now < rotation.transition.stopAt
          ? { previous:
                { x25519: b64(rotation.previous.x25519)
                , ed25519: b64(rotation.previous.ed25519)
                , fingerprint: rotation.previous.fingerprint }
            , transition:
                { stopAt: new Date(rotation.transition.stopAt).toISOString()
                , signature: b64(rotation.transition.signature) } }
          : {})
      })
  }

/** Prefix of the `SRS_KEY_TRANSITION` setting. */
export const TRANSITION_SETTING_PREFIX = 'srs-rotate-v1:'

/** A parsed key transition: when the old keys stop working, and the old signing key's statement. */
export type KeyTransition = { stopAt: number, signature: Uint8Array }

/**
 * Sign a transition from the current bundle to a new one.
 *
 * @param previous - The bundle being replaced (holds the signing key).
 * @param next - The new bundle.
 * @param stopAt - When the old bundle stops being accepted.
 * @returns The transition and its `SRS_KEY_TRANSITION` setting value.
 */
export const createTransition =
  (previous: ServerKeys, next: ServerKeys, stopAt: number): { transition: KeyTransition, setting: string } => {
    const signature = ed25519Sign(transitionMessage(previous, next, stopAt), previous.ed25519Private)
    const stop = new Uint8Array(8)
    new DataView(stop.buffer).setBigUint64(0, BigInt(stopAt))
    return (
      { transition: { stopAt, signature }
      , setting: TRANSITION_SETTING_PREFIX + Buffer.concat([stop, signature]).toString('base64url')
      })
  }

/**
 * Read the `SRS_KEY_TRANSITION` setting.
 *
 * @param setting - The setting value.
 * @throws When it is malformed; the message names the setting.
 */
export const parseTransition =
  (setting: string): KeyTransition => {
    if (!setting.startsWith(TRANSITION_SETTING_PREFIX))
      throw new Error(`SRS_KEY_TRANSITION must start with "${TRANSITION_SETTING_PREFIX}"`)
    const raw = Buffer.from(setting.slice(TRANSITION_SETTING_PREFIX.length), 'base64url')
    if (raw.length !== 72) throw new Error('SRS_KEY_TRANSITION is not a valid transition')
    return { stopAt: Number(raw.readBigUInt64BE(0)), signature: new Uint8Array(raw.subarray(8)) }
  }
