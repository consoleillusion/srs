import { Hono } from 'hono'
import { registerAuthRoutes } from '../../auth/routes.ts'
import { publicBundle, type KeyTransition } from '../../auth/server-keys.ts'
import type { ServerKeys } from '../../protocol/server-keys.ts'
import { createAuthService } from '../../auth/service/index.ts'
import type { BuiltSchema } from '../../db/schema-types.ts'
import { innerOf, type AppContext, type Env } from '../context.ts'
import { pathParam } from '../context.ts'
import type { RowDatabase } from '../database.ts'
import { ApiError } from '../errors.ts'
import type { Registry } from '../registry.ts'
import { applyHttp, clientAddress, type HttpOptions } from '../http.ts'
import { sessionMiddleware } from '../session.ts'
import { createChannelStore } from '../channels.ts'
import { registerHandshake } from '../noise-handshake.ts'
import { registerEnvelopeRoute } from '../noise-route.ts'
import { registerChannelAccounts } from '../../auth/channel-accounts.ts'
import { registerChannelLifecycle } from '../../auth/channel-lifecycle.ts'
import { requestMessage } from '../../protocol/accounts.ts'
import { ed25519Verify } from '../../client/crypto.ts'
import { crudHandlers } from './crud.ts'
import { errorDocument, jsonApi } from './document.ts'
import { createGuard, rolesOf } from './guard.ts'
import { relationshipHandlers } from './relationships.ts'
import { createServices } from './services.ts'

export { operationOf } from './negotiate.ts'

/** Options for {@link createApp}. */
export type AppOptions =
  { built: BuiltSchema
  , db: RowDatabase
  /** Enables the OPAQUE registration and login routes when set. */
  , opaqueServerSetup?: string
  /** Require a valid session on every request that is not `public`. */
  , requireSession?: boolean
  /** Usernames that always hold the "admin" role. */
  , admins?: string[]
  /** Transport settings: body limit, CORS, proxy trust, rate limit and logging. */
  , http?: HttpOptions
  /** The server key bundle; enables `GET /noise/keys` and the Noise transport. */
  , serverKeys?: ServerKeys
  /** During a key rotation: the previous bundle and the signed transition to `serverKeys`. */
  , rotation?: { previous: ServerKeys, transition: KeyTransition }
  /**
   * `noise` serves only the handshake, envelope, key-bundle and health routes in
   * the clear and refuses everything else; `bearer` serves every route directly
   * and needs TLS. Defaults to `noise` when `serverKeys` is set.
   */
  , transport?: 'noise' | 'bearer'
  /** Retain every signed read, not only reads listed in `x-access.signed`. */
  , retainReads?: boolean
  /** Allow admins to issue password reset tokens (default true). */
  , allowReset?: boolean
  /**
   * The path the API is mounted under, such as `/api`, when the platform
   * strips it before the request reaches SRS. Links and request signatures
   * include it.
   */
  , basePath?: string
  }

/** Routes served outside a Noise channel in strict mode. */
export const CLEAR_ROUTES =
  new Set(['/healthz', '/readyz', '/noise/keys', '/noise/handshake', '/noise'])

const paths =
  { collection: '/:type'
  , item: '/:type/:id'
  , relationship: '/:type/:id/relationships/:rel'
  , related: '/:type/:id/:rel'
  }

/** What each route offers, and only reads on a read-only view. */
const allowed =
  { collection: { read: 'GET, HEAD, OPTIONS', write: 'GET, HEAD, POST, OPTIONS' }
  , item:
      { read: 'GET, HEAD, OPTIONS'
      , write: 'GET, HEAD, PUT, PATCH, DELETE, OPTIONS'
      }
  , relationship:
      { read: 'GET, HEAD, OPTIONS'
      , write: 'GET, HEAD, PATCH, POST, DELETE, OPTIONS'
      }
  , related: { read: 'GET, HEAD, OPTIONS', write: 'GET, HEAD, OPTIONS' }
  } as const

/** The OPTIONS response for one route, reflecting whether the resource is writable. */
const optionsFor =
  (c: AppContext, registry: Registry, route: keyof typeof allowed) => {
    const resource = registry.get(pathParam(c, 'type'))
    const methods =
      resource?.readOnly ? allowed[route].read : allowed[route].write
    return c.body(null, 204, { allow: methods })
  }

/**
 * Build the JSON:API Hono app for a built schema.
 *
 * @param options - The schema, database and security settings.
 * @returns A Hono app serving every exposed resource.
 */
export const createApp =
  ({ built, db, opaqueServerSetup, requireSession, admins = [], http = {}, serverKeys, rotation, transport = serverKeys ? 'noise' : 'bearer', retainReads = false, allowReset = true, basePath = '' }: AppOptions): Hono => {
    const s = createServices(built, db)
    const app = new Hono<Env>()
    const base = basePath.replace(/\/+$/, '')
    if (base && !base.startsWith('/')) throw new Error('basePath must start with /')
    if (base) app.use('*', async (c, next) => { c.set('base', base); await next() })
    applyHttp(app, db, http)

    if (transport === 'noise' && !serverKeys)
      throw new Error('The Noise transport needs a server key bundle')
    if (transport === 'noise')
      app.use('*', async (c, next) => {
        // Strict mode: nothing but the clear routes is served outside a channel.
        if (innerOf(c) || CLEAR_ROUTES.has(c.req.path)) return next()
        return jsonApi(
          c
          , errorDocument(426, 'Upgrade Required', 'This server accepts requests only through its Noise channel')
          , 426 as 400)
      })

    const channels = createChannelStore()
    if (serverKeys) {
      app.get('/noise/keys', c => c.json(publicBundle(serverKeys, rotation)))
      registerHandshake(
        app
        , { serverKeys, channels, clientOf: c => clientAddress(c, http.trustedProxyHops)
          , previous: rotation ? { keys: rotation.previous, until: rotation.transition.stopAt } : undefined })
      registerEnvelopeRoute(
        app
        , { channels
          , clientOf: c => clientAddress(c, http.trustedProxyHops)
          , checkSignature: (channel, request, n) => {
              if (!channel.login) return { signed: false }
              const contentType = request.headers.find(([name]) => name === 'content-type')?.[1] ?? ''
              const signedMessage =
                requestMessage(
                  { h: channel.handshakeHash, sid: channel.sid, n, method: request.method
                  , path: request.path, contentType, body: request.body })
              return ed25519Verify(request.signature, signedMessage, channel.login.sessionPublic)
                ? { signed: true, signature: request.signature, signedMessage }
                : { signed: false, rejected: true }
            }
          })
    }

    if (opaqueServerSetup)
      registerAuthRoutes(
        app
        , c => clientAddress(c, http.trustedProxyHops)
        , createAuthService(
            { db
            , serverSetup: opaqueServerSetup
            , audit: s.registry.get('audit_log') !== undefined
            , onLogin: http.metrics?.login
            }))

    if (opaqueServerSetup && serverKeys) {
      const auditing = s.registry.get('audit_log') !== undefined
      registerChannelAccounts(
        app
        , { db, serverSetup: opaqueServerSetup, channels, audit: auditing, onLogin: http.metrics?.login })
      registerChannelLifecycle(
        app
        , { db
          , serverSetup: opaqueServerSetup
          , channels
          , audit: auditing
          , allowReset
          , isAdmin: async userId =>
              (await rolesOf(
                { db, registry: s.registry, adminNames: admins.map(x => x.toLowerCase()) }, userId))
                .includes('admin')
          })
    }

    const requireAuth = requireSession ? sessionMiddleware(db) : undefined
    const guard =
      createGuard(
        { db
        , registry: s.registry
        , adminNames: admins.map(x => x.toLowerCase())
        , retainReads
        , requireAuth
        })
    for (const path of Object.values(paths)) app.use(path, guard)
    if (requireAuth) app.use('/', requireAuth)

    const crud = crudHandlers(s)
    const related = relationshipHandlers(s, crud.collection)
    const read = ['GET', 'HEAD']
    app.on(read, '/', related.catalog)
    app.on(read, paths.collection, crud.list)
    app.post(paths.collection, crud.create)
    app.on(read, paths.item, crud.getOne)
    app.put(paths.item, crud.update('put'))
    app.patch(paths.item, crud.update('patch'))
    app.delete(paths.item, crud.remove)
    app.on(read, paths.relationship, related.getRelationship)
    app.patch(paths.relationship, related.writeRelationship('replace'))
    app.post(paths.relationship, related.writeRelationship('add'))
    app.delete(paths.relationship, related.writeRelationship('remove'))
    app.on(read, paths.related, related.getRelated)

    app.options(paths.collection, c => optionsFor(c, s.registry, 'collection'))
    app.options(paths.item, c => optionsFor(c, s.registry, 'item'))
    app.options(
      paths.relationship, c => optionsFor(c, s.registry, 'relationship'))
    app.options(paths.related, c => optionsFor(c, s.registry, 'related'))
    app.options('/', c => c.body(null, 204, { allow: 'GET, HEAD, OPTIONS' }))

    app.onError((error, c) => {
      if (!(error instanceof ApiError)) console.error(error)

      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError(500, 'Internal Server Error', 'Internal server error')

      return jsonApi(
        c
        , errorDocument(
            apiError.status
            , apiError.title
            , apiError.message
            , apiError.parameter)
        , apiError.status as 400)
    })

    app.notFound(c =>
      jsonApi(c, errorDocument(404, 'Not Found', 'Route not found'), 404))

    // Callers see a plain Hono app; the typed variables are internal to the server
    return app as unknown as Hono
  }
