import type { Context, Hono } from 'hono'
import { getConnInfo } from 'hono/bun'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { NONCE_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../auth/signing.ts'
import { errorDocument, jsonApi } from './app/document.ts'
import type { AppContext, Env, Next } from './context.ts'
import type { RowDatabase } from './database.ts'

/** Transport-level settings: size limits, CORS, proxy trust, rate limiting and logging. */
export type HttpOptions =
  { /** Largest accepted request body in bytes (default 1 MiB). */
    maxBodyBytes?: number
  /** Origins allowed to call the API from a browser; `*` allows any. None by default. */
  , corsOrigins?: string[]
  /** How many reverse proxies sit in front of the server, so `X-Forwarded-For` can be trusted (default 0). */
  , trustedProxyHops?: number
  /** Requests allowed per client address per minute; 0 or unset turns the limit off. */
  , rateLimitPerMinute?: number
  /** Receives one structured record per request; unset turns request logging off. */
  , log?: (record: Record<string, unknown>) => void
  }

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

const WINDOW_MS = 60_000
const MAX_TRACKED_CLIENTS = 50_000
const HEALTH_PATHS = new Set(['/healthz', '/readyz'])

/**
 * Identify the calling client for rate limiting.
 *
 * @param c - The request context.
 * @param hops - How many trusted proxies are in front of the server.
 * @returns The socket address, or the client address the outermost trusted proxy saw.
 */
export const clientAddress =
  (c: Context, hops = 0): string => {
    // Purpose: pick the socket address, or the address a trusted proxy recorded, as the client identity
    let socket = 'unknown'
    try {
      socket = getConnInfo(c).remote.address ?? 'unknown'
    } catch {
      // No socket (for example when the app is called in-process): keep 'unknown'.
    }
    if (hops <= 0) return socket

    // Each trusted proxy appends the address it received the request from, so
    // the entry `hops` from the right is the client; earlier entries are forgeable.
    const forwarded =
      (c.req.header('x-forwarded-for') ?? '')
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)
    return forwarded[forwarded.length - hops] ?? socket
  }

/** Build the rate-limit middleware: a fixed window per client address, held in memory. */
const rateLimiter =
  (perMinute: number, hops: number) => {
    // Purpose: build a middleware that rejects a client after perMinute requests in one window
    const windows = new Map<string, { count: number, resetAt: number }>()

    return async (c: AppContext, next: Next) => {
      // Purpose: count this request against its client and answer 429 when the window is full
      if (HEALTH_PATHS.has(c.req.path)) return next()

      const now = Date.now()
      if (windows.size >= MAX_TRACKED_CLIENTS)
        for (const [key, value] of windows)
          if (value.resetAt <= now) windows.delete(key)

      const key = clientAddress(c, hops)
      let entry = windows.get(key)
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + WINDOW_MS }
        windows.set(key, entry)
      }
      entry.count += 1

      const retryAfter = String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000)))
      c.header('ratelimit-limit', String(perMinute))
      c.header('ratelimit-remaining', String(Math.max(0, perMinute - entry.count)))
      if (entry.count > perMinute)
        return jsonApi(
          c
          , errorDocument(429, 'Too Many Requests', 'Too many requests; try again later')
          , 429
          , { 'retry-after': retryAfter })
      return next()
    }
  }

/** Build the middleware that tags each request with an id and logs one record when it ends. */
const requestLogger =
  (sink: (record: Record<string, unknown>) => void) =>
    async (c: AppContext, next: Next) => {
      // Purpose: time the request, expose its id, and emit one structured record after it finishes
      const supplied = c.req.header('x-request-id')
      const id =
        supplied !== undefined && /^[A-Za-z0-9._-]{1,64}$/.test(supplied)
          ? supplied
          : crypto.randomUUID()
      const started = performance.now()
      c.header('x-request-id', id)
      await next()
      sink(
        { time: new Date().toISOString()
        , id
        , method: c.req.method
        // The query string is left out: it can carry filter values that are personal data.
        , path: c.req.path
        , status: c.res.status
        , ms: Math.round(performance.now() - started)
        , user: c.get('userId') ?? null
        })
    }

/**
 * Install the transport layer on an app: request ids and logging, security
 * headers, CORS, rate limiting, a request size limit, and the health routes.
 * Call this before any other route is registered.
 *
 * @param app - The Hono app to extend.
 * @param db - The database, used by the readiness check.
 * @param options - The transport settings.
 */
export const applyHttp =
  (app: Hono<Env>, db: RowDatabase, options: HttpOptions = {}) => {
    // Purpose: register the cross-cutting middleware and the liveness and readiness routes
    const hops = options.trustedProxyHops ?? 0
    if (options.log) app.use('*', requestLogger(options.log))

    app.use('*', secureHeaders())

    const origins = options.corsOrigins ?? []
    if (origins.length > 0)
      app.use(
        '*'
        , cors(
            { origin: origins.includes('*') ? '*' : origins
            , allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
            , allowHeaders:
                [ 'authorization'
                , 'content-type'
                , 'accept'
                , SIGNATURE_HEADER
                , TIMESTAMP_HEADER
                , NONCE_HEADER
                ]
            , exposeHeaders: ['location', 'x-request-id', 'retry-after']
            , maxAge: 600
            }))

    if (options.rateLimitPerMinute && options.rateLimitPerMinute > 0)
      app.use('*', rateLimiter(options.rateLimitPerMinute, hops))

    app.use(
      '*'
      , bodyLimit(
          { maxSize: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
          , onError: c =>
              jsonApi(
                c
                , errorDocument(413, 'Payload Too Large', 'Request body is too large')
                , 413)
          }))

    // Liveness says the process is up; readiness also proves the database answers.
    app.get('/healthz', c => c.json({ status: 'ok' }))
    app.get(
      '/readyz'
      , async c => {
          // Purpose: report 200 when the database answers a trivial query and 503 when it does not
          try {
            await db.get('SELECT 1 AS ok')
            return c.json({ status: 'ready' })
          } catch (error) {
            console.error('readiness check failed', error)
            return c.json({ status: 'unavailable' }, 503)
          }
        })
  }

/**
 * Read the transport settings from environment variables.
 *
 * `SRS_MAX_BODY_BYTES`, `SRS_CORS_ORIGINS` (comma-separated),
 * `SRS_TRUSTED_PROXY_HOPS`, `SRS_RATE_LIMIT_PER_MINUTE` (default 600, 0 turns it
 * off) and `SRS_LOG` (`false` turns request logging off).
 *
 * @param env - The environment to read, `process.env` by default.
 * @returns The settings, with one JSON line per request written to stdout.
 */
export const httpOptionsFromEnv =
  (env: Record<string, string | undefined> = process.env): HttpOptions => {
    // Purpose: turn SRS_* environment variables into validated transport settings
    const integer =
      (name: string, fallback: number) => {
        // Purpose: read a non-negative integer variable or fail with its name
        const raw = env[name]
        if (raw === undefined || raw === '') return fallback
        if (!/^\d+$/.test(raw))
          throw new Error(`${name} must be a non-negative integer, got "${raw}"`)
        return Number(raw)
      }

    return (
      { maxBodyBytes: integer('SRS_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES)
      , corsOrigins:
          (env.SRS_CORS_ORIGINS ?? '').split(',').map(x => x.trim()).filter(Boolean)
      , trustedProxyHops: integer('SRS_TRUSTED_PROXY_HOPS', 0)
      , rateLimitPerMinute: integer('SRS_RATE_LIMIT_PER_MINUTE', 600)
      , log:
          env.SRS_LOG === 'false'
            ? undefined
            : record => console.log(JSON.stringify(record))
      })
  }
