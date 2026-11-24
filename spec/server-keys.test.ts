import { describe, expect, test } from 'bun:test'
import { createServerKeys, parseServerKeys, SERVER_KEYS_SETTING_PREFIX } from '../src/auth/server-keys.ts'
import { createApp } from '../src/server/app/index.ts'
import { createTestServer, opaqueServerSetup } from './helpers/test-server.ts'

describe('server key bundle', () => {
  test('a created bundle round-trips through its setting', () => {
    const { keys, setting } = createServerKeys()
    expect(setting.startsWith(SERVER_KEYS_SETTING_PREFIX)).toBe(true)
    expect(parseServerKeys(setting).fingerprint).toBe(keys.fingerprint)
    expect(keys.fingerprint).toMatch(/^srs1:[a-z2-7]{52}$/)
  })

  test('a malformed setting fails without echoing its value', () => {
    const secret = 'srs-keys-v1:c2hvcnQ'
    expect(() => parseServerKeys(secret)).toThrow('SRS_SERVER_KEYS is not a valid key bundle')
    try {
      parseServerKeys(secret)
    } catch (error) {
      expect(String(error)).not.toContain('c2hvcnQ')
    }
    expect(() => parseServerKeys('nope')).toThrow('must start with')
  })

  test('GET /noise/keys serves the public bundle and never a private key', async () => {
    const { built, db } = await createTestServer({ session: true })
    const { keys, setting } = createServerKeys()
    const app = createApp({ built, db, opaqueServerSetup, requireSession: true, serverKeys: keys })
    const response = await app.request('/noise/keys')
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body).toEqual(
      { version: 1
      , x25519: Buffer.from(keys.x25519).toString('base64url')
      , ed25519: Buffer.from(keys.ed25519).toString('base64url')
      , fingerprint: keys.fingerprint
      })
    const text = JSON.stringify(body)
    expect(text).not.toContain(Buffer.from(keys.x25519Private).toString('base64url'))
    expect(text).not.toContain(setting.slice(SERVER_KEYS_SETTING_PREFIX.length, 40))
  })

  test('without a bundle the route does not exist', async () => {
    const { app } = await createTestServer({ session: true })
    expect((await app.request('/noise/keys')).status).not.toBe(200)
  })
})
