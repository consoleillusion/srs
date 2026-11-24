import { describe, expect, test } from 'bun:test'
import { createServerKeys } from '../../src/auth/server-keys.ts'
import { serveConsole } from '../../src/console/serve.ts'
import { createApp } from '../../src/server/app/index.ts'
import { createTestServer, opaqueServerSetup } from '../helpers/test-server.ts'

describe('srs console', () => {
  test('serves the page and its script on loopback, and nothing else', async () => {
    const server = await serveConsole({ port: 0 })
    try {
      expect(server.hostname).toBe('127.0.0.1')
      const base = `http://127.0.0.1:${server.port}`
      const page = await fetch(`${base}/`)
      expect(page.headers.get('content-type')).toContain('text/html')
      expect(await page.text()).toContain('<script type="module" src="/app.js">')
      const script = await fetch(`${base}/app.js`)
      expect(script.headers.get('content-type')).toContain('javascript')
      const code = await script.text()
      // The page must work where crypto.subtle is missing (plain HTTP, not localhost).
      expect(code).not.toMatch(/crypto\.subtle\.(digest|sign|verify|importKey|encrypt|decrypt|deriveBits)/)
      expect((await fetch(`${base}/.env`)).status).toBe(404)
    } finally {
      server.stop(true)
    }
  }, 60_000)

  test('a console on another origin can reach the Noise routes in strict mode', async () => {
    const { built, db } = await createTestServer({ session: true })
    const app =
      createApp(
        { built, db, opaqueServerSetup, requireSession: true, serverKeys: createServerKeys().keys
        , http: { corsOrigins: ['http://127.0.0.1:5735'] } })
    const preflight =
      await app.request('/noise', { method: 'OPTIONS'
        , headers: { origin: 'http://127.0.0.1:5735', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } })
    expect(preflight.status).toBeLessThan(300)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5735')
    const keys = await app.request('/noise/keys', { headers: { origin: 'http://127.0.0.1:5735' } })
    expect(keys.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5735')
  })
})
