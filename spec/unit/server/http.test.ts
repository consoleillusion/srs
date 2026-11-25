import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { Env } from '../../../src/server/context.ts'
import { applyHttp, clientAddress, httpOptionsFromEnv } from '../../../src/server/http.ts'

const db = { get: async () => ({ ok: 1 }) } as never

/** Build an app with the transport layer and one echo route. */
const build = (options: Parameters<typeof applyHttp>[2] = {}) => {
  const app = new Hono<Env>()
  applyHttp(app, db, options)
  app.post('/echo', async c => c.json(await c.req.json()))
  app.get('/thing', c => c.json({ ok: true }))
  return app
}

describe('health routes', () => {
  test('liveness and readiness answer without a session', async () => {
    const app = build()
    expect((await app.request('/healthz')).status).toBe(200)
    expect((await app.request('/readyz')).status).toBe(200)
  })

  test('readiness reports 503 when the database fails', async () => {
    const app = new Hono<Env>()
    const failing = { get: async () => { throw new Error('down') } } as never
    const quiet = console.error
    console.error = () => undefined
    applyHttp(app, failing)
    const response = await app.request('/readyz')
    console.error = quiet
    expect(response.status).toBe(503)
  })
})

describe('body limit', () => {
  test('rejects a body over the limit with a JSON:API error', async () => {
    const app = build({ maxBodyBytes: 20 })
    const response =
      await app.request(
        '/echo'
        , { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(100) }), headers: { 'content-type': 'application/json' } })
    expect(response.status).toBe(413)
    expect(response.headers.get('content-type')).toContain('application/vnd.api+json')
  })

  test('accepts a body under the limit', async () => {
    const app = build({ maxBodyBytes: 100 })
    const response =
      await app.request(
        '/echo'
        , { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } })
    expect(response.status).toBe(200)
  })
})

describe('security headers and CORS', () => {
  test('adds security headers by default and no CORS headers', async () => {
    const response = await build().request('/thing', { headers: { origin: 'https://evil.example' } })
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('allows only the listed origins', async () => {
    const app = build({ corsOrigins: ['https://app.example'] })
    const allowed = await app.request('/thing', { headers: { origin: 'https://app.example' } })
    const other = await app.request('/thing', { headers: { origin: 'https://evil.example' } })
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example')
    expect(other.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('answers a preflight with the signing headers allowed', async () => {
    const app = build({ corsOrigins: ['https://app.example'] })
    const response =
      await app.request(
        '/thing'
        , { method: 'OPTIONS'
          , headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' }
          })
    expect(response.headers.get('access-control-allow-headers')).toContain('x-srs-signature')
  })
})

describe('rate limit', () => {
  test('rejects requests past the limit and sets retry-after', async () => {
    const app = build({ rateLimitPerMinute: 2 })
    expect((await app.request('/thing')).status).toBe(200)
    expect((await app.request('/thing')).status).toBe(200)
    const limited = await app.request('/thing')
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  test('never limits the health routes', async () => {
    const app = build({ rateLimitPerMinute: 1 })
    for (let i = 0; i < 5; i++)
      expect((await app.request('/healthz')).status).toBe(200)
  })

  test('counts clients separately behind a trusted proxy', async () => {
    const app = build({ rateLimitPerMinute: 1, trustedProxyHops: 1 })
    const from = (ip: string) => app.request('/thing', { headers: { 'x-forwarded-for': ip } })
    expect((await from('1.1.1.1')).status).toBe(200)
    expect((await from('2.2.2.2')).status).toBe(200)
    expect((await from('1.1.1.1')).status).toBe(429)
  })

  test('ignores a forged leading X-Forwarded-For entry', async () => {
    const app = build({ rateLimitPerMinute: 1, trustedProxyHops: 1 })
    const from = (forged: string) =>
      app.request('/thing', { headers: { 'x-forwarded-for': `${forged}, 9.9.9.9` } })
    expect((await from('1.1.1.1')).status).toBe(200)
    expect((await from('2.2.2.2')).status).toBe(429)
  })
})

describe('request logging', () => {
  test('logs one record without the query string and echoes the request id', async () => {
    const records: Record<string, unknown>[] = []
    const app = build({ log: record => records.push(record) })
    const response = await app.request('/thing?filter[x]=secret', { headers: { 'x-request-id': 'abc-123' } })
    expect(response.headers.get('x-request-id')).toBe('abc-123')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ method: 'GET', path: '/thing', status: 200, id: 'abc-123' })
    expect(JSON.stringify(records[0])).not.toContain('secret')
  })

  test('replaces an unsafe request id', async () => {
    const records: Record<string, unknown>[] = []
    const app = build({ log: record => records.push(record) })
    await app.request('/thing', { headers: { 'x-request-id': 'bad id\twith spaces' } })
    expect(records[0]!.id).not.toBe('bad id\twith spaces')
  })
})

describe('clientAddress', () => {
  test('falls back to the socket when the header has fewer entries than hops', async () => {
    const app = new Hono()
    app.get('/', c => c.text(clientAddress(c, 3)))
    const response = await app.request('/', { headers: { 'x-forwarded-for': '1.1.1.1' } })
    expect(await response.text()).toBe('unknown')
  })
})

describe('httpOptionsFromEnv', () => {
  test('reads defaults', () => {
    const options = httpOptionsFromEnv({})
    expect(options.rateLimitPerMinute).toBe(600)
    expect(options.corsOrigins).toEqual([])
    expect(options.log).toBeDefined()
  })

  test('parses values and turns logging off', () => {
    const options =
      httpOptionsFromEnv(
        { SRS_CORS_ORIGINS: 'https://a.example, https://b.example'
        , SRS_TRUSTED_PROXY_HOPS: '2'
        , SRS_RATE_LIMIT_PER_MINUTE: '0'
        , SRS_LOG: 'false'
        })
    expect(options.corsOrigins).toEqual(['https://a.example', 'https://b.example'])
    expect(options.trustedProxyHops).toBe(2)
    expect(options.rateLimitPerMinute).toBe(0)
    expect(options.log).toBeUndefined()
  })

  test('rejects a malformed number naming the variable', () => {
    expect(() => httpOptionsFromEnv({ SRS_MAX_BODY_BYTES: '10MB' })).toThrow('SRS_MAX_BODY_BYTES')
  })
})
