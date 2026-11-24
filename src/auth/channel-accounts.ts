/**
 * Accounts over the Noise transport: registration with an identity key, login
 * bound to the channel, and session certificates (design book, Accounts and
 * login). Every route here exists only inside a channel; outside one it is
 * `404`.
 *
 * @module
 */
import * as opaque from '@serenity-kit/opaque'
import type { Hono } from 'hono'
import { base64UrlToBytes, bytesToBase64Url } from '../client/crypto.ts'
import { decodeCertificate } from '../protocol/encoding.ts'
import
  { equalBytes
  , loginBinder
  , registrationProofMessage
  , verifyCertificate
  , WRAPPED_IDENTITY_LENGTH
  } from '../protocol/accounts.ts'
import { ed25519Verify } from '../client/crypto.ts'
import type { ChannelStore } from '../server/channels.ts'
import { innerOf, type AppContext, type Env } from '../server/context.ts'
import type { RowDatabase } from '../server/database.ts'
import { badRequest, conflict, notFound, unauthorized } from '../server/errors.ts'
import { ajv, errorField } from '../server/ajv.ts'
import { readJson } from '../server/io.ts'
import { canonicalUuid, newUuid, uuidToBuffer } from '../server/uuid.ts'
import { createDeps } from './service/deps.ts'
import { inTransaction, iso, mapWriteError, opaqueStep, parseStored, REGISTRATION_TTL_MS, LOGIN_TTL_MS } from './service/helpers.ts'
import type { Limits } from './limits.ts'
import { isObject } from '../server/guard.ts'

/** How long a login lasts. */
export const LOGIN_RECORD_TTL_MS = 24 * 60 * 60_000
/** How far a certificate's `issuedAt` may be from the server clock. */
export const CERTIFICATE_CLOCK_SKEW_MS = 5 * 60_000

const base64url = { type: 'string', pattern: '^[A-Za-z0-9_-]+$' }

const schemas =
  { registrationStart:
      { type: 'object', additionalProperties: false, required: ['username', 'registrationRequest']
      , properties:
          { username: { type: 'string', minLength: 1, maxLength: 100 }
          , displayName: { type: 'string', maxLength: 100 }
          , registrationRequest: { type: 'string', minLength: 1 } } }
  , registrationFinish:
      { type: 'object', additionalProperties: false
      , required: ['registrationRecord', 'identityPublic', 'wrappedIdentity', 'proof']
      , properties:
          { registrationRecord: { type: 'string', minLength: 1 }
          , identityPublic: base64url, wrappedIdentity: base64url, proof: base64url } }
  , loginStart:
      { type: 'object', additionalProperties: false, required: ['username', 'startLoginRequest']
      , properties:
          { username: { type: 'string', minLength: 1, maxLength: 100 }
          , startLoginRequest: { type: 'string', minLength: 1 } } }
  , loginFinish:
      { type: 'object', additionalProperties: false, required: ['finishLoginRequest', 'binder']
      , properties: { finishLoginRequest: { type: 'string', minLength: 1 }, binder: base64url } }
  , session:
      { type: 'object', additionalProperties: false, required: ['certificate', 'signature']
      , properties: { certificate: base64url, signature: base64url } }
  }
const validators = Object.fromEntries(Object.entries(schemas).map(([k, v]) => [k, ajv.compile(v)])) as
  Record<keyof typeof schemas, ReturnType<typeof ajv.compile>>

/** Validate a JSON body against one of the route schemas. */
export const body =
  async (c: AppContext, name: keyof typeof schemas): Promise<Record<string, string>> => {
    const value = await readJson(c)
    const validate = validators[name]
    if (!validate(value) || !isObject(value)) {
      const field = errorField(validate, 'body')
      throw badRequest(`"${field}" is invalid`, field)
    }
    return value as Record<string, string>
  }

/** Decode base64url or fail with a 400 naming the field. */
export const bytes =
  (value: string, field: string): Uint8Array => {
    try {
      return base64UrlToBytes(value)
    } catch {
      throw badRequest(`"${field}" is not base64url`, field)
    }
  }

/** The channel of a request, or 404 when it did not come through one. */
export const channelOf =
  (c: AppContext) => {
    const inner = innerOf(c)
    if (!inner) throw notFound('Route not found')
    return inner
  }

/** The user's current identity key row, if it has one that is neither revoked nor retired. */
export const currentIdentity =
  async (db: RowDatabase, userId: Uint8Array) =>
    db.get(
      "SELECT `id`, `jwk`, `material` FROM `key` WHERE `user_id` = ? AND `type` = 'identity'"
      + ' AND `revoked_at` IS NULL AND `retired_at` IS NULL ORDER BY `updated_at` DESC LIMIT 1'
      , [userId])

/** The public key stored in an identity row's JWK. */
export const identityPublicOf =
  (row: { jwk?: unknown }): Uint8Array =>
    base64UrlToBytes((parseStored(row.jwk, 'identity key') as { x: string }).x)

/**
 * Register the account routes that run inside a Noise channel.
 *
 * @param app - The app.
 * @param options - Database, OPAQUE setup, channel table, audit flag, login counter and limits.
 */
export const registerChannelAccounts =
  ( app: Hono<Env>
  , options:
      { db: RowDatabase
      , serverSetup: string
      , channels: ChannelStore
      , audit?: boolean
      , onLogin?: (outcome: 'success' | 'failure') => void
      , limits?: Limits
      }) => {
    const { db, serverSetup, channels } = options
    const { throttle, record, purgeExpired, insertKey, consume } = createDeps(options)

    app.post('/account/registration', async c => {
      const inner = channelOf(c)
      await opaque.ready
      const input = await body(c, 'registrationStart')
      const username = input.username!.toLowerCase()
      await throttle.register(inner.client)
      await purgeExpired()
      if (await db.get('SELECT 1 FROM `user` WHERE lower(`username`) = ? LIMIT 1', [username]))
        throw conflict('A user with that username already exists')

      const userId = newUuid()
      const id = crypto.randomUUID()
      const expiresAt = Date.now() + REGISTRATION_TTL_MS
      const { registrationResponse } =
        opaqueStep('registrationRequest', () =>
          opaque.server.createRegistrationResponse(
            { serverSetup, userIdentifier: userId, registrationRequest: input.registrationRequest! }))
      await insertKey(db,
        { id, type: 'opaque_registration', expiresAt
        , material: JSON.stringify({ username, displayName: input.displayName || null, userId }) })
      return c.json({ id, userId, registrationResponse, expiresAt: iso(expiresAt) }, 201)
    })

    app.put('/account/registration/:id', async c => {
      const inner = channelOf(c)
      await opaque.ready
      const input = await body(c, 'registrationFinish')
      const identityPublic = bytes(input.identityPublic!, 'identityPublic')
      const wrapped = bytes(input.wrappedIdentity!, 'wrappedIdentity')
      const proof = bytes(input.proof!, 'proof')
      if (identityPublic.length !== 32) throw badRequest('"identityPublic" must be 32 bytes', 'identityPublic')
      if (wrapped.length !== WRAPPED_IDENTITY_LENGTH) throw badRequest('"wrappedIdentity" has the wrong length', 'wrappedIdentity')
      const idValue = uuidOrBadRequest(c.req.param('id'))

      const result = await inTransaction(db, async tx => {
        const now = Date.now()
        const consumed = await consume(tx, 'opaque_registration', idValue, now, '`material`')
        const pending = parseStored(consumed.material, 'registration state') as Record<string, unknown>
        if (typeof pending.username !== 'string' || typeof pending.userId !== 'string')
          throw new Error('Stored registration state is invalid')

        const userId = uuidToBuffer(pending.userId)
        const message = registrationProofMessage(inner.channel.handshakeHash, userId, pending.username, identityPublic)
        if (!ed25519Verify(proof, message, identityPublic))
          throw badRequest('"proof" does not verify', 'proof')

        // Reject unusable records now; the throw rolls the consume back.
        probeRecord(serverSetup, input.registrationRecord!)

        try {
          await tx.run(
            'INSERT INTO `user` (`id`, `username`, `display_name`, `owner`) VALUES (?, ?, ?, ?)'
            , [userId, pending.username, typeof pending.displayName === 'string' ? pending.displayName : null, userId])
        } catch (error) {
          throw mapWriteError(error)
        }
        await tx.run(
          'UPDATE `key` SET `material` = ?, `user_id` = ?, `owner` = ?, `expires_at` = NULL, `consumed_at` = ? WHERE `id` = ?'
          , [input.registrationRecord, userId, userId, now, idValue])
        await insertKey(tx,
          { id: newUuid(), type: 'identity', userId: pending.userId
          , jwk: { kty: 'OKP', crv: 'Ed25519', x: bytesToBase64Url(identityPublic) }
          , material: bytesToBase64Url(wrapped) })
        return { userId: pending.userId }
      })
      return c.json(result, 201)
    })

    app.post('/account/login', async c => {
      const inner = channelOf(c)
      await opaque.ready
      const input = await body(c, 'loginStart')
      const username = input.username!.toLowerCase()
      await throttle.start(username, inner.client)
      await purgeExpired()

      // Unknown users get a response of the same shape, so login start does not reveal who exists.
      const user = await db.get('SELECT `id` FROM `user` WHERE lower(`username`) = ? LIMIT 1', [username])
      const stored =
        user
          ? await db.get(
              "SELECT `material` FROM `key` WHERE `user_id` = ? AND `type` = 'opaque_registration'"
              + ' AND `consumed_at` IS NOT NULL AND `expires_at` IS NULL AND `material` IS NOT NULL'
              + ' ORDER BY `consumed_at` DESC LIMIT 1'
              , [user.id])
          : undefined
      const userId = typeof stored?.material === 'string' ? canonicalUuid(user!.id) : null
      const { loginResponse, serverLoginState } =
        opaqueStep('startLoginRequest', () =>
          opaque.server.startLogin(
            { serverSetup, registrationRecord: userId ? stored!.material as string : null
            , startLoginRequest: input.startLoginRequest!, userIdentifier: userId ?? newUuid() }))

      const id = crypto.randomUUID()
      const expiresAt = Date.now() + LOGIN_TTL_MS
      await insertKey(db, { id, type: 'opaque_login_state', material: serverLoginState, expiresAt, userId })
      await throttle.track(id, username)
      return c.json({ id, loginResponse, expiresAt: iso(expiresAt) }, 201)
    })

    app.put('/account/login/:id', async c => {
      const inner = channelOf(c)
      await opaque.ready
      const input = await body(c, 'loginFinish')
      const id = c.req.param('id')
      const idValue = uuidOrBadRequest(id)
      const now = Date.now()
      const login = await consume(db, 'opaque_login_state', idValue, now, '`user_id`, `material`')

      let sessionKey: Uint8Array | undefined
      if (login.user_id)
        try {
          sessionKey =
            base64UrlToBytes(
              opaque.server.finishLogin(
                { serverLoginState: String(login.material), finishLoginRequest: input.finishLoginRequest! })
                .sessionKey)
        } catch {
          sessionKey = undefined
        }
      const binder = bytes(input.binder!, 'binder')
      const bound =
        sessionKey !== undefined
        && equalBytes(binder, loginBinder(sessionKey, inner.channel.handshakeHash, inner.channel.sid))
      if (!bound) {
        await throttle.fail(id.toLowerCase())
        await record('login_failed', login.user_id)
        throw unauthorized('Invalid username or password')
      }
      const account =
        await db.get('SELECT `disabled_at` FROM `user` WHERE `id` = ?', [login.user_id])
      if (account?.disabled_at !== null && account?.disabled_at !== undefined) {
        await record('login_failed', login.user_id)
        throw unauthorized('Invalid username or password')
      }
      await throttle.succeed(id.toLowerCase())
      await record('login', login.user_id)

      const identity = await currentIdentity(db, login.user_id as Uint8Array)
      const loginId = newUuid()
      const expiresAt = now + LOGIN_RECORD_TTL_MS
      const userId = canonicalUuid(login.user_id)
      await insertKey(db, { id: loginId, type: 'login', userId, expiresAt })
      // Without a usable identity key (it was revoked), the only thing this login may do is re-key.
      if (!identity) inner.channel.pendingRekey = { userId, loginId }
      const reset =
        await db.get(
          "SELECT max(`updated_at`) AS `at` FROM `audit_log` WHERE `action` = 'reset_used' AND `resource_id` = ?"
          , [login.user_id]).catch(() => undefined)
      return c.json(
        { loginId
        , userId
        , expiresAt: iso(expiresAt)
        , identityPublic: identity ? bytesToBase64Url(identityPublicOf(identity)) : null
        , wrappedIdentity: identity ? identity.material : null
        , rekeyRequired: !identity
        , lastReset: iso(reset?.at)
        })
    })

    app.post('/account/session', async c => {
      const inner = channelOf(c)
      const input = await body(c, 'session')
      const certificate = bytes(input.certificate!, 'certificate')
      const signature = bytes(input.signature!, 'signature')
      const refused = () => unauthorized('Invalid session certificate')
      if (inner.channel.login) throw conflict('This channel is already logged in')

      let cert: ReturnType<typeof decodeCertificate>
      try {
        cert = decodeCertificate(certificate)
      } catch {
        throw refused()
      }
      const now = Date.now()
      if (!equalBytes(cert.sid, inner.channel.sid)
          || !equalBytes(cert.h, inner.channel.handshakeHash)
          || Math.abs(cert.issuedAt - now) > CERTIFICATE_CLOCK_SKEW_MS
          || cert.expiresAt <= now)
        throw refused()

      const login =
        await db.get(
          "SELECT `user_id`, `expires_at` FROM `key` WHERE `id` = ? AND `type` = 'login'"
          + ' AND `consumed_at` IS NULL AND `expires_at` > ?'
          , [cert.loginId, now])
      if (!login || !(login.user_id instanceof Uint8Array) || !equalBytes(login.user_id, cert.userId)
          || cert.expiresAt > Number(login.expires_at))
        throw refused()

      const identity = await currentIdentity(db, cert.userId)
      if (!identity || !verifyCertificate(identityPublicOf(identity), certificate, signature)) throw refused()

      const certificateId = newUuid()
      await insertKey(db,
        { id: certificateId, type: 'certificate', userId: canonicalUuid(cert.userId)
        , material: JSON.stringify(
            { certificate: bytesToBase64Url(certificate), signature: bytesToBase64Url(signature)
            , identityKey: canonicalUuid(identity.id), acceptedAt: now }) })
      inner.channel.login =
        { userId: canonicalUuid(cert.userId)
        , loginId: canonicalUuid(cert.loginId)
        , sessionPublic: cert.sessionPublic
        , certificateId
        , expiresAt: cert.expiresAt
        }
      void channels
      return c.json({ certificateId, expiresAt: iso(cert.expiresAt) }, 201)
    })
  }

/**
 * Check that an OPAQUE registration record is usable by starting a throwaway
 * login against it; answers 400 naming `registrationRecord` otherwise.
 *
 * @param serverSetup - The OPAQUE server setup.
 * @param record - The registration record.
 */
export const probeRecord =
  (serverSetup: string, record: string) =>
    opaqueStep('registrationRecord', () =>
      opaque.server.startLogin(
        { serverSetup, registrationRecord: record
        , startLoginRequest: opaque.client.startLogin({ password: 'probe' }).startLoginRequest
        , userIdentifier: newUuid() }))

/**
 * Store a user's new OPAQUE record, replacing the old one, so only the new
 * password works.
 *
 * @param tx - The transaction.
 * @param userId - The user.
 * @param record - The new registration record.
 * @param now - The current time.
 */
export const replaceOpaqueRecord =
  async (tx: RowDatabase, userId: Uint8Array, record: string, now: number) => {
    await tx.run(
      "DELETE FROM `key` WHERE `user_id` = ? AND `type` = 'opaque_registration' AND `expires_at` IS NULL"
      , [userId])
    await tx.run(
      'INSERT INTO `key` (`id`, `type`, `material`, `user_id`, `owner`, `consumed_at`) VALUES (?, ?, ?, ?, ?, ?)'
      , [uuidToBuffer(newUuid()), 'opaque_registration', record, userId, userId, now])
  }

/** Parse a path id as a UUID buffer, or answer 400. */
export const uuidOrBadRequest =
  (value: string) => {
    try {
      return uuidToBuffer(value)
    } catch {
      throw badRequest('"id" must be a canonical UUID', 'id')
    }
  }
