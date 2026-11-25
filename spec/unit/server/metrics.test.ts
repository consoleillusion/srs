import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { Env } from '../../../src/server/context.ts'
import { applyHttp } from '../../../src/server/http.ts'
import { createMetrics, serveMetrics } from '../../../src/server/metrics.ts'
import { signIn } from '../../helpers/session.ts'
import { createTestServer } from '../../helpers/test-server.ts'
import { createApp } from '../../../src/server/app/index.ts'

describe('metrics registry', () => {
  test('counts requests by route pattern, not by path', async () => {
    const metrics = createMetrics()
    const app = new Hono<Env>()
    applyHttp(app, { get: async () => ({}) } as never, { metrics })
    app.get('/thing/:id', c => c.text('ok'))
    await app.request('/thing/1')
    await app.request('/thing/2')
    await app.request('/missing')
    const text = metrics.render()
    expect(text).toContain('srs_http_requests_total{method="GET",route="/thing/:id",status="200"} 2')
    expect(text).not.toContain('/thing/1')
    expect(text).toContain('srs_http_request_duration_seconds_count{method="GET",route="/thing/:id"} 2')
    expect(text).toMatch(/route="[^"]*",status="404"\} 1/)
  })

  test('histogram buckets are cumulative', () => {
    const metrics = createMetrics()
    metrics.request('GET', '/', 200, 0.02)
    metrics.request('GET', '/', 200, 3)
    const text = metrics.render()
    expect(text).toContain('le="0.01"} 0')
    expect(text).toContain('le="0.025"} 1')
    expect(text).toContain('le="5"} 2')
    expect(text).toContain('le="+Inf"} 2')
  })

  test('reports backup age only after a backup', () => {
    const metrics = createMetrics()
    expect(metrics.render()).not.toContain('srs_backup_age_seconds')
    metrics.backup(1_000)
    expect(metrics.render(61_000)).toContain('srs_backup_age_seconds 60')
  })

  test('escapes label values', () => {
    const metrics = createMetrics()
    metrics.request('GET', 'a"b\\c', 200, 0)
    expect(metrics.render()).toContain('route="a\\"b\\\\c"')
  })
})

describe('login metrics', () => {
  test('counts successful and failed logins', async () => {
    const metrics = createMetrics()
    const { app: base, built, db } = await createTestServer({ session: true })
    const { opaqueServerSetup } = await import('../../helpers/test-server.ts')
    const app = createApp({ built, db, opaqueServerSetup, requireSession: true, http: { metrics } })
    await signIn(app, 'alice')
    await signIn(app, 'bob')
    expect(metrics.render()).toContain('srs_logins_total{outcome="success"} 2')
    void base
  })
})

describe('metrics listener', () => {
  test('serves /metrics on 127.0.0.1 and nothing else', async () => {
    const metrics = createMetrics()
    metrics.login('failure')
    const server = serveMetrics(metrics, 0)
    try {
      const ok = await fetch(`http://127.0.0.1:${server.port}/metrics`)
      expect(ok.status).toBe(200)
      expect(await ok.text()).toContain('srs_logins_total{outcome="failure"} 1')
      expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(404)
      expect(server.hostname).toBe('127.0.0.1')
    } finally {
      server.stop(true)
    }
  })
})
