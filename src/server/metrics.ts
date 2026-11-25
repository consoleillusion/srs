/**
 * In-process metrics in the Prometheus text format. Served on a separate
 * listener bound to `127.0.0.1` when `SRS_METRICS_PORT` is set; see the design
 * book, Operations.
 *
 * @module
 */

/** Upper bounds, in seconds, of the request duration histogram buckets. */
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

/** Collects counters and timings and renders them for a scraper. */
export interface Metrics {
  /**
   * Record one finished request.
   *
   * @param method - The HTTP method.
   * @param route - The matched route pattern, such as `/:type/:id`.
   * @param status - The response status.
   * @param seconds - How long the request took.
   */
  request(method: string, route: string, status: number, seconds: number): void
  /**
   * Record one login attempt.
   *
   * @param outcome - Whether the login succeeded.
   */
  login(outcome: 'success' | 'failure'): void
  /**
   * Record a successful backup.
   *
   * @param at - When it finished, in milliseconds since the epoch.
   */
  backup(at: number): void
  /**
   * Render every metric in the Prometheus text exposition format.
   *
   * @param now - The current time, for the backup age; defaults to now.
   */
  render(now?: number): string
}

/** Quote a label value for the exposition format. */
const label =
  (value: string) =>
    `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`

/**
 * Create an empty metrics registry.
 *
 * @returns A registry whose `render` output starts at zero.
 */
export const createMetrics =
  (): Metrics => {
    const requests = new Map<string, number>()
    const durations = new Map<string, { buckets: number[], sum: number, count: number }>()
    const logins = { success: 0, failure: 0 }
    let lastBackup: number | undefined

    return (
      { request: (method, route, status, seconds) => {
          const key = `method=${label(method)},route=${label(route)},status=${label(String(status))}`
          requests.set(key, (requests.get(key) ?? 0) + 1)

          const timing = `method=${label(method)},route=${label(route)}`
          const entry =
            durations.get(timing)
            ?? { buckets: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 }
          DURATION_BUCKETS.forEach((bound, i) => {
            if (seconds <= bound) entry.buckets[i]! += 1
          })
          entry.sum += seconds
          entry.count += 1
          durations.set(timing, entry)
        }
      , login: outcome => {
          logins[outcome] += 1
        }
      , backup: at => {
          lastBackup = at
        }
      , render: (now = Date.now()) => {
          const lines: string[] = []
          lines.push(
            '# HELP srs_http_requests_total Requests handled, by method, route pattern and status.'
            , '# TYPE srs_http_requests_total counter')
          for (const [key, value] of [...requests].sort())
            lines.push(`srs_http_requests_total{${key}} ${value}`)

          lines.push(
            '# HELP srs_http_request_duration_seconds Time to handle a request.'
            , '# TYPE srs_http_request_duration_seconds histogram')
          for (const [key, entry] of [...durations].sort(([a], [b]) => a.localeCompare(b))) {
            DURATION_BUCKETS.forEach((bound, i) =>
              lines.push(`srs_http_request_duration_seconds_bucket{${key},le="${bound}"} ${entry.buckets[i]}`))
            lines.push(
              `srs_http_request_duration_seconds_bucket{${key},le="+Inf"} ${entry.count}`
              , `srs_http_request_duration_seconds_sum{${key}} ${entry.sum}`
              , `srs_http_request_duration_seconds_count{${key}} ${entry.count}`)
          }

          lines.push(
            '# HELP srs_logins_total Login attempts, by outcome.'
            , '# TYPE srs_logins_total counter'
            , `srs_logins_total{outcome="success"} ${logins.success}`
            , `srs_logins_total{outcome="failure"} ${logins.failure}`)

          if (lastBackup !== undefined)
            lines.push(
              '# HELP srs_backup_age_seconds Seconds since the last successful backup.'
              , '# TYPE srs_backup_age_seconds gauge'
              , `srs_backup_age_seconds ${Math.max(0, (now - lastBackup) / 1000)}`)

          return lines.join('\n') + '\n'
        }
      })
  }

/**
 * Serve the metrics on `127.0.0.1` only, so they are never reachable from the
 * network.
 *
 * @param metrics - The registry to expose.
 * @param port - The port to listen on.
 * @returns The running server.
 */
export const serveMetrics =
  (metrics: Metrics, port: number) =>
    Bun.serve(
      { hostname: '127.0.0.1'
      , port
      , fetch: request =>
          new URL(request.url).pathname === '/metrics'
            ? new Response(metrics.render(), { headers: { 'content-type': 'text/plain; version=0.0.4' } })
            : new Response('Not Found', { status: 404 })
      })
