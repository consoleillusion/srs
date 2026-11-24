/**
 * The account lifecycle over the Noise transport: logout, devices, password
 * change, revocation and re-keying, admin resets and disabling users (design
 * book, Account lifecycle). Every route exists only inside a channel, and every
 * change is audited.
 *
 * @module
 */
import * as opaque from '@serenity-kit/opaque'
import type { Hono } from 'hono'
import { sha256 } from '@noble/hashes/sha2.js'
import { base64UrlToBytes, bytesToBase64Url, ed25519Verify, randomBytes } from '../client/crypto.ts'
import { registrationProofMessage, WRAPPED_IDENTITY_LENGTH } from '../protocol/accounts.ts'
import type { ChannelStore } from '../server/channels.ts'
import type { AppContext, Env } from '../server/context.ts'
import type { RowDatabase } from '../server/database.ts'
import { badRequest, forbidden, notFound, unauthorized } from '../server/errors.ts'
import { insert } from '../server/sql.ts'
import { canonicalUuid, newUuid, uuidToBuffer, UUID_PATTERN } from '../server/uuid.ts'
import { ajv, errorField } from '../server/ajv.ts'
import { readJson } from '../server/io.ts'
import { isObject } from '../server/guard.ts'
import { bytes, channelOf, probeRecord, replaceOpaqueRecord, uuidOrBadRequest } from './channel-accounts.ts'
import { createDeps } from './service/deps.ts'
import { inTransaction, iso, opaqueStep, parseStored, REGISTRATION_TTL_MS } from './service/helpers.ts'

/** How long an admin reset token is valid. */
export const RESET_TOKEN_TTL_MS = 60 * 60_000

const base64url = { type: 'string', pattern: '^[A-Za-z0-9_-]+$' }
const schemas =
  { start:
      { type: 'object', additionalProperties: false, required: ['registrationRequest']
      , properties: { registrationRequest: { type: 'string', minLength: 1 } } }
  , password:
      { type: 'object', additionalProperties: false, required: ['registrationRecord', 'wrappedIdentity']
      , properties:
          { registrationRecord: { type: 'string', minLength: 1 }, wrappedIdentity: base64url
          , keepOtherLogins: { type: 'boolean' } } }
  , rekey:
      { type: 'object', additionalProperties: false
      , required: ['registrationRecord', 'identityPublic', 'wrappedIdentity', 'proof']
      , properties:
          { registrationRecord: { type: 'string', minLength: 1 }
          , identityPublic: base64url, wrappedIdentity: base64url, proof: base64url } }
  , resetIssue:
      { type: 'object', additionalProperties: false, required: ['userId']
      , properties: { userId: { type: 'string', pattern: UUID_PATTERN.source } } }
  , resetStart:
      { type: 'object', additionalProperties: false, required: ['token', 'registrationRequest']
      , properties: { token: base64url, registrationRequest: { type: 'string', minLength: 1 } } }
  }
const validators = Object.fromEntries(Object.entries(schemas).map(([k, v]) => [k, ajv.compile(v)])) as
  Record<keyof typeof schemas, ReturnType<typeof ajv.compile>>

const body =
  async (c: AppContext, name: keyof typeof schemas): Promise<Record<string, unknown>> => {
    const value = await readJson(c)
    const validate = validators[name]
    if (!validate(value) || !isObject(value)) {
      const field = errorField(validate, 'body')
      throw badRequest(`"${field}" is invalid`, field)
    }
    return value
  }

/** The logged-in channel of a request, or 401. */
const loggedIn =
  (c: AppContext) => {
    const inner = channelOf(c)
    const login = inner.channel.login
    if (!login) throw unauthorized('Session is required')
    return { inner, login, userId: uuidToBuffer(login.userId) }
  }

/** Check a new identity key's material and proof of possession. */
const newIdentity =
  (input: Record<string, unknown>, h: Uint8Array, userId: Uint8Array, username: string) => {
    const identityPublic = bytes(String(input.identityPublic), 'identityPublic')
    const wrapped = bytes(String(input.wrappedIdentity), 'wrappedIdentity')
    if (identityPublic.length !== 32) throw badRequest('"identityPublic" must be 32 bytes', 'identityPublic')
    if (wrapped.length !== WRAPPED_IDENTITY_LENGTH) throw badRequest('"wrappedIdentity" has the wrong length', 'wrappedIdentity')
    const proof = bytes(String(input.proof), 'proof')
    if (!ed25519Verify(proof, registrationProofMessage(h, userId, username, identityPublic), identityPublic))
      throw badRequest('"proof" does not verify', 'proof')
    return { identityPublic, wrapped }
  }

/**
 * Register the lifecycle routes.
 *
 * @param app - The app.
 * @param options - Database, OPAQUE setup, channel table, audit flag, the admin check, and whether admin resets are allowed.
 */
export const registerChannelLifecycle =
  ( app: Hono<Env>
  , options:
      { db: RowDatabase
      , serverSetup: string
      , channels: ChannelStore
      , audit?: boolean
      , isAdmin: (userId: string) => Promise<boolean>
      , allowReset?: boolean
      }) => {
    const { db, serverSetup, channels } = options
    const { insertKey, consume, purgeExpired } = createDeps(options)

    /** Write one lifecycle event to the audit log. */
    const audit =
      async (tx: RowDatabase, action: string, actor: Uint8Array | null, subject: Uint8Array | null) => {
        if (options.audit)
          await insert(tx, 'audit_log', { actor, action, resource: 'account', resource_id: subject })
      }

    /** End logins in the database and drop their channels. */
    const endLogins =
      async (tx: RowDatabase, userId: Uint8Array, except?: string) => {
        const rows =
          await tx.all(
            "SELECT `id` FROM `key` WHERE `user_id` = ? AND `type` = 'login' AND `consumed_at` IS NULL"
            , [userId])
        for (const row of rows) {
          const id = canonicalUuid(row.id)
          if (id === except) continue
          await tx.run('UPDATE `key` SET `consumed_at` = ? WHERE `id` = ?', [Date.now(), row.id])
          channels.endLogin(id)
        }
      }

    // ── Logout and devices ───────────────────────────────────────────────

    app.delete('/account/login/current', async c => {
      const { login, userId } = loggedIn(c)
      await db.run("UPDATE `key` SET `consumed_at` = ? WHERE `id` = ? AND `type` = 'login'", [Date.now(), uuidToBuffer(login.loginId)])
      await audit(db, 'logout', userId, userId)
      channels.endLogin(login.loginId)
      return c.body(null, 204)
    })

    app.get('/account/logins', async c => {
      const { login, userId } = loggedIn(c)
      const rows =
        await db.all(
          "SELECT `id`, `updated_at`, `expires_at` FROM `key` WHERE `user_id` = ? AND `type` = 'login'"
          + ' AND `consumed_at` IS NULL AND `expires_at` > ? ORDER BY `updated_at` DESC'
          , [userId, Date.now()])
      return c.json(
        { logins: rows.map(row => (
            { id: canonicalUuid(row.id)
            , createdAt: iso(row.updated_at)
            , expiresAt: iso(row.expires_at)
            , current: canonicalUuid(row.id) === login.loginId
            })) })
    })

    app.delete('/account/logins/:id', async c => {
      const { userId } = loggedIn(c)
      const id = uuidOrBadRequest(c.req.param('id'))
      const result =
        await db.run(
          "UPDATE `key` SET `consumed_at` = ? WHERE `id` = ? AND `user_id` = ? AND `type` = 'login' AND `consumed_at` IS NULL"
          , [Date.now(), id, userId])
      if (result.changes === 0) throw notFound('Login not found')
      channels.endLogin(canonicalUuid(id))
      await audit(db, 'logout', userId, userId)
      return c.body(null, 204)
    })

    app.delete('/account/logins', async c => {
      const { login, userId } = loggedIn(c)
      if (c.req.query('others') !== 'true') throw badRequest('Use ?others=true to end every other login', 'others')
      await endLogins(db, userId, login.loginId)
      await audit(db, 'logout_others', userId, userId)
      return c.body(null, 204)
    })

    // ── Password change ──────────────────────────────────────────────────

    /** Start an OPAQUE registration for an existing user, for a password change or a re-key. */
    const startFor =
      async (c: AppContext, userId: string, purpose: string) => {
        await opaque.ready
        const input = await body(c, 'start')
        const id = crypto.randomUUID()
        const expiresAt = Date.now() + REGISTRATION_TTL_MS
        const { registrationResponse } =
          opaqueStep('registrationRequest', () =>
            opaque.server.createRegistrationResponse(
              { serverSetup, userIdentifier: userId, registrationRequest: String(input.registrationRequest) }))
        await insertKey(db, { id, type: 'opaque_registration', expiresAt, material: JSON.stringify({ userId, purpose }) })
        return c.json({ id, registrationResponse, expiresAt: iso(expiresAt) }, 201)
      }

    /** Consume a pending registration started by {@link startFor} for this user and purpose. */
    const consumeFor =
      async (tx: RowDatabase, id: string, userId: string, purpose: string) => {
        const pending =
          parseStored((await consume(tx, 'opaque_registration', uuidOrBadRequest(id), Date.now(), '`material`')).material
          , 'registration state') as Record<string, unknown>
        if (pending.userId !== userId || pending.purpose !== purpose)
          throw unauthorized('Registration state is invalid, expired, or already used')
      }

    app.post('/account/password', async c => {
      const { login } = loggedIn(c)
      return startFor(c, login.userId, 'password')
    })

    app.put('/account/password/:id', async c => {
      const { login, userId } = loggedIn(c)
      await opaque.ready
      const input = await body(c, 'password')
      const wrapped = bytes(String(input.wrappedIdentity), 'wrappedIdentity')
      if (wrapped.length !== WRAPPED_IDENTITY_LENGTH) throw badRequest('"wrappedIdentity" has the wrong length', 'wrappedIdentity')
      probeRecord(serverSetup, String(input.registrationRecord))
      await inTransaction(db, async tx => {
        await consumeFor(tx, c.req.param('id'), login.userId, 'password')
        const now = Date.now()
        await replaceOpaqueRecord(tx, userId, String(input.registrationRecord), now)
        // The identity key does not change; only its wrapping does.
        await tx.run(
          "UPDATE `key` SET `material` = ? WHERE `user_id` = ? AND `type` = 'identity' AND `revoked_at` IS NULL AND `retired_at` IS NULL"
          , [bytesToBase64Url(wrapped), userId])
        if (input.keepOtherLogins !== true) await endLogins(tx, userId, login.loginId)
        await audit(tx, 'password_change', userId, userId)
      })
      return c.body(null, 204)
    })

    // ── Revocation and re-keying ─────────────────────────────────────────

    /** Revoke a user's current identity key and end every login. */
    const revoke =
      async (tx: RowDatabase, actor: Uint8Array, userId: Uint8Array) => {
        const now = Date.now()
        await tx.run(
          "UPDATE `key` SET `revoked_at` = ? WHERE `user_id` = ? AND `type` = 'identity' AND `revoked_at` IS NULL AND `retired_at` IS NULL"
          , [now, userId])
        await endLogins(tx, userId)
        await audit(tx, 'identity_revoked', actor, userId)
      }

    app.post('/account/identity/revoke', async c => {
      const { userId } = loggedIn(c)
      await inTransaction(db, tx => revoke(tx, userId, userId))
      return c.body(null, 204)
    })

    // Declared before `admin` below is used; routes run only after registration completes.
    app.post('/account/users/:id/revoke', async c => {
      const { userId: actor } = await admin(c)
      const subject = uuidOrBadRequest(c.req.param('id'))
      if (!await db.get('SELECT 1 FROM `user` WHERE `id` = ?', [subject])) throw notFound('User not found')
      await inTransaction(db, tx => revoke(tx, actor, subject))
      return c.body(null, 204)
    })

    app.post('/account/rekey', async c => {
      const inner = channelOf(c)
      const pending = inner.channel.pendingRekey
      if (!pending) throw unauthorized('Log in first; re-keying follows a login whose identity key was revoked')
      return startFor(c, pending.userId, 'rekey')
    })

    app.put('/account/rekey/:id', async c => {
      const inner = channelOf(c)
      const pending = inner.channel.pendingRekey
      if (!pending) throw unauthorized('Log in first; re-keying follows a login whose identity key was revoked')
      await opaque.ready
      const input = await body(c, 'rekey')
      const userId = uuidToBuffer(pending.userId)
      const user = await db.get('SELECT `username` FROM `user` WHERE `id` = ?', [userId])
      const { identityPublic, wrapped } = newIdentity(input, inner.channel.handshakeHash, userId, String(user?.username))
      probeRecord(serverSetup, String(input.registrationRecord))
      await inTransaction(db, async tx => {
        await consumeFor(tx, c.req.param('id'), pending.userId, 'rekey')
        await replaceOpaqueRecord(tx, userId, String(input.registrationRecord), Date.now())
        await insertKey(tx,
          { id: newUuid(), type: 'identity', userId: pending.userId
          , jwk: { kty: 'OKP', crv: 'Ed25519', x: bytesToBase64Url(identityPublic) }
          , material: bytesToBase64Url(wrapped) })
        await audit(tx, 'rekey', userId, userId)
      })
      inner.channel.pendingRekey = undefined
      return c.json({ loginId: pending.loginId, identityPublic: bytesToBase64Url(identityPublic) }, 201)
    })

    // ── Admin resets and disabling users ─────────────────────────────────

    /** The logged-in admin, or 403. */
    const admin =
      async (c: AppContext) => {
        const caller = loggedIn(c)
        if (!await options.isAdmin(caller.login.userId)) throw forbidden('Only an admin can do this')
        return caller
      }

    const tokenHash = (token: Uint8Array) => sha256(token)

    app.post('/account/resets', async c => {
      if (options.allowReset === false) throw notFound('Route not found')
      const { userId: actor } = await admin(c)
      const input = await body(c, 'resetIssue')
      const subject = uuidToBuffer(String(input.userId))
      if (!await db.get('SELECT 1 FROM `user` WHERE `id` = ?', [subject])) throw notFound('User not found')
      const token = randomBytes(32)
      const expiresAt = Date.now() + RESET_TOKEN_TTL_MS
      await insertKey(db,
        { id: newUuid(), type: 'reset_token', userId: canonicalUuid(subject), expiresAt
        , material: bytesToBase64Url(tokenHash(token)) })
      await audit(db, 'reset_issued', actor, subject)
      // The token is shown once; only its hash is stored.
      return c.json({ token: bytesToBase64Url(token), expiresAt: iso(expiresAt) }, 201)
    })

    app.post('/account/reset', async c => {
      if (options.allowReset === false) throw notFound('Route not found')
      channelOf(c)
      await opaque.ready
      await purgeExpired()
      const input = await body(c, 'resetStart')
      const hash = bytesToBase64Url(tokenHash(bytes(String(input.token), 'token')))
      const row =
        await db.get(
          "SELECT `id`, `user_id` FROM `key` WHERE `type` = 'reset_token' AND `material` = ?"
          + ' AND `consumed_at` IS NULL AND `expires_at` > ?'
          , [hash, Date.now()])
      if (!row) throw unauthorized('Reset token is invalid, expired, or already used')
      const userId = canonicalUuid(row.user_id)
      const id = crypto.randomUUID()
      const expiresAt = Date.now() + REGISTRATION_TTL_MS
      const { registrationResponse } =
        opaqueStep('registrationRequest', () =>
          opaque.server.createRegistrationResponse(
            { serverSetup, userIdentifier: userId, registrationRequest: String(input.registrationRequest) }))
      await insertKey(db,
        { id, type: 'opaque_registration', expiresAt
        , material: JSON.stringify({ userId, purpose: 'reset', token: canonicalUuid(row.id) }) })
      return c.json({ id, userId, registrationResponse, expiresAt: iso(expiresAt) }, 201)
    })

    app.put('/account/reset/:id', async c => {
      if (options.allowReset === false) throw notFound('Route not found')
      const inner = channelOf(c)
      await opaque.ready
      const input = await body(c, 'rekey')
      probeRecord(serverSetup, String(input.registrationRecord))
      const result = await inTransaction(db, async tx => {
        const now = Date.now()
        const pending =
          parseStored((await consume(tx, 'opaque_registration', uuidOrBadRequest(c.req.param('id')), now, '`material`')).material
          , 'registration state') as Record<string, unknown>
        if (pending.purpose !== 'reset' || typeof pending.userId !== 'string' || typeof pending.token !== 'string')
          throw unauthorized('Reset state is invalid, expired, or already used')
        const used =
          await tx.run(
            "UPDATE `key` SET `consumed_at` = ? WHERE `id` = ? AND `type` = 'reset_token' AND `consumed_at` IS NULL AND `expires_at` > ?"
            , [now, uuidToBuffer(pending.token), now])
        if (used.changes === 0) throw unauthorized('Reset token is invalid, expired, or already used')

        const userId = uuidToBuffer(pending.userId)
        const user = await tx.get('SELECT `username` FROM `user` WHERE `id` = ?', [userId])
        const { identityPublic, wrapped } = newIdentity(input, inner.channel.handshakeHash, userId, String(user?.username))
        await replaceOpaqueRecord(tx, userId, String(input.registrationRecord), now)
        // The old key is retired, not revoked: what it signed before the reset stays valid.
        await tx.run(
          "UPDATE `key` SET `retired_at` = ? WHERE `user_id` = ? AND `type` = 'identity' AND `revoked_at` IS NULL AND `retired_at` IS NULL"
          , [now, userId])
        await insertKey(tx,
          { id: newUuid(), type: 'identity', userId: pending.userId
          , jwk: { kty: 'OKP', crv: 'Ed25519', x: bytesToBase64Url(identityPublic) }
          , material: bytesToBase64Url(wrapped) })
        await endLogins(tx, userId)
        await audit(tx, 'reset_used', userId, userId)
        return { userId: pending.userId }
      })
      return c.json(result, 201)
    })

    for (const [path, disabled] of [['disable', true], ['enable', false]] as const)
      app.post(`/account/users/:id/${path}`, async c => {
        const { userId: actor } = await admin(c)
        const subject = uuidOrBadRequest(c.req.param('id'))
        const result =
          await db.run('UPDATE `user` SET `disabled_at` = ? WHERE `id` = ?', [disabled ? Date.now() : null, subject])
        if (result.changes === 0) throw notFound('User not found')
        if (disabled) await endLogins(db, subject)
        await audit(db, disabled ? 'user_disabled' : 'user_enabled', actor, subject)
        return c.body(null, 204)
      })

    void base64UrlToBytes
  }
