import { randomBytes } from '../client/crypto.ts'
import { ProtocolError } from '../protocol/errors.ts'
import { serverKeysFromSecret, type ServerKeys } from '../protocol/server-keys.ts'

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
 */
export const publicBundle =
  (keys: ServerKeys) => (
    { version: 1
    , x25519: Buffer.from(keys.x25519).toString('base64url')
    , ed25519: Buffer.from(keys.ed25519).toString('base64url')
    , fingerprint: keys.fingerprint
    })
