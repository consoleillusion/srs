/**
 * The client for the Noise transport (design book, Transport; Accounts and
 * login; Signed requests). Every request travels encrypted through a channel to
 * the pinned server, and every request after login is signed by a session key
 * that the user's identity key certifies.
 *
 * The identity key is held in memory only. Reloading the page or ending the
 * process ends the ability to resume; the user logs in again.
 *
 * @module
 */
import * as opaque from '@serenity-kit/opaque'
import { hexToBytes } from '@noble/hashes/utils.js'
import
  { loginBinder
  , registrationProofMessage
  , requestMessage
  , signCertificate
  , unwrapIdentity
  , wrapIdentity
  } from '../protocol/accounts.ts'
import { ProtocolError } from '../protocol/errors.ts'
import type { PublicServerKeys } from '../protocol/server-keys.ts'
import { fetchServerKeys, openChannel, type Channel, type ChannelResponse } from './channel.ts'
import
  { base64UrlToBytes
  , bytesToBase64Url
  , ed25519PublicKey
  , ed25519Sign
  , randomBytes
  } from './crypto.ts'
import { ResourceServerError } from './errors.ts'
import type { FetchLike } from './http.ts'

const JSON_API = 'application/vnd.api+json'
const JSON_TYPE = 'application/json'
/** How long a session certificate is valid; the login's expiry caps it. */
const CERTIFICATE_TTL_MS = 24 * 60 * 60_000

/** Settings for {@link createSecureClient}. */
export type SecureClientOptions =
  { /** The server's base URL; defaults to the current origin. */
    baseUrl?: string
  /** The `srs1:` fingerprint of the server's key bundle, as printed by `srs init`. */
  , serverKey: string
  /** Fetch implementation; defaults to `globalThis.fetch`. */
  , fetch?: FetchLike
  /**
   * Called when the client follows a server key rotation signed by the pinned
   * keys, with the new fingerprint to pin from now on. Store it.
   */
  , onServerKeyChange?: (fingerprint: string) => void
  }

/** Who the client is logged in as. */
export type SecureLogin =
  { userId: string
  , loginId: string
  , expiresAt: string
  }

/** A client for a server using the Noise transport. */
export type SecureClient = {
  /** Create an account, then log in unless `signIn` is false. */
  register: (
    input: { username: string, password: string, displayName?: string }
    , options?: { signIn?: boolean }) => Promise<{ userId: string }>
  /**
   * Log in with username and password. If the user's identity key was revoked,
   * `newPassword` is required: the client re-keys and changes the password in
   * the same step.
   */
  login: (input: { username: string, password: string, newPassword?: string }) => Promise<SecureLogin>
  /** Change the password; the identity key stays the same. Ends other logins unless asked not to. */
  changePassword: (newPassword: string, options?: { keepOtherLogins?: boolean }) => Promise<void>
  /** List the user's active logins. */
  logins: () => Promise<{ id: string, createdAt: string, expiresAt: string, current: boolean }[]>
  /** End one login, or every login but this one. */
  endLogin: (id: string | 'others') => Promise<void>
  /** Revoke the identity key: every login ends, and the next login must re-key and change the password. */
  revokeIdentity: () => Promise<void>
  /** Set a new password with a reset token from an admin; the old identity key is retired. Then logs in. */
  redeemReset: (input: { username: string, token: string, newPassword: string }) => Promise<SecureLogin>
  /** Admin actions on other users. */
  admin: {
    /** Issue a one-hour reset token to hand to the user out of band. */
    issueReset: (userId: string) => Promise<{ token: string, expiresAt: string }>
    /** Disable or enable a user, or revoke their identity key. */
    setDisabled: (userId: string, disabled: boolean) => Promise<void>
    /** Revoke a user's identity key. */
    revoke: (userId: string) => Promise<void>
  }
  /** End the login on the server and forget every key. */
  logout: () => Promise<void>
  /** Send a request through the channel; signed when logged in. Never throws for an HTTP status. */
  request: (path: string, init?: { method?: string, headers?: Record<string, string>, body?: string | Uint8Array }) => Promise<ChannelResponse>
  /** GET a path and return the JSON body. */
  get: <T = unknown>(path: string) => Promise<T>
  /** POST a JSON:API document and return the JSON response. */
  post: <T = unknown>(path: string, body: unknown) => Promise<T>
  /** PATCH a JSON:API document and return the JSON response. */
  patch: <T = unknown>(path: string, body: unknown) => Promise<T>
  /** PUT a JSON:API document and return the JSON response. */
  put: <T = unknown>(path: string, body: unknown) => Promise<T>
  /** DELETE a path. */
  delete: (path: string) => Promise<void>
  /** The current login, or null. */
  readonly currentLogin: SecureLogin | null
  /** Whether the client is logged in. */
  readonly isSignedIn: boolean
}

/** What the client holds while logged in; memory only. */
type LoginState =
  SecureLogin &
  { identityPrivate: Uint8Array
  , identityPublic: Uint8Array
  , sessionPrivate: Uint8Array
  }

/** Turn a non-2xx channel response into an error. */
const failure =
  (response: ChannelResponse): ResourceServerError => {
    const document = response.json<{ errors?: { title?: string, detail?: string, source?: { parameter?: string } }[] }>()
    const error = document?.errors?.[0]
    return new ResourceServerError(
      response.status, error?.title ?? 'Error', error?.detail ?? `Request failed with ${response.status}`
      , error?.source?.parameter, document)
  }

const uuidBytes = (value: string) => hexToBytes(value.replaceAll('-', ''))

/**
 * Create a client for a server that uses the Noise transport.
 *
 * @param options - The server address, its pinned key fingerprint, and optionally a fetch.
 * @example
 * ```ts
 * const client = createSecureClient({ baseUrl: 'http://10.0.0.5:5734', serverKey: 'srs1:…' })
 * await client.register({ username: 'alice', password })
 * await client.post('/note', { data: { type: 'note', attributes: { text: 'hi' } } })
 * ```
 */
export const createSecureClient =
  (options: SecureClientOptions): SecureClient => {
    const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    const baseUrl =
      (options.baseUrl ?? (globalThis as { location?: { origin?: string } }).location?.origin ?? '').replace(/\/+$/, '')
    let serverKeys: PublicServerKeys | undefined
    let pin = options.serverKey.trim().toLowerCase()
    let channel: Channel | undefined
    let login: LoginState | undefined

    /** Certify a fresh session key for the current channel. */
    const certify =
      async (target: Channel, state: LoginState) => {
        const sessionPrivate = randomBytes(32)
        const now = Date.now()
        const { certificate, signature } =
          signCertificate(state.identityPrivate,
            { userId: uuidBytes(state.userId), loginId: uuidBytes(state.loginId), sid: target.sid
            , h: target.handshakeHash, sessionPublic: ed25519PublicKey(sessionPrivate)
            , issuedAt: now
            , expiresAt: Math.min(now + CERTIFICATE_TTL_MS, Date.parse(state.expiresAt)) })
        const response =
          await target.send(
            { method: 'POST', path: '/account/session', headers: [['content-type', JSON_TYPE]]
            , body: new TextEncoder().encode(JSON.stringify(
                { certificate: bytesToBase64Url(certificate), signature: bytesToBase64Url(signature) })) })
        if (response.status !== 201) throw failure(response)
        state.sessionPrivate = sessionPrivate
      }

    /** The open channel, opening (and resuming the login on) a new one when needed. */
    const ensureChannel =
      async (): Promise<Channel> => {
        if (channel) return channel
        if (!serverKeys) {
          const fetched = await fetchServerKeys(fetchImpl, baseUrl, pin)
          serverKeys = fetched.keys
          if (fetched.fingerprint !== pin) {
            pin = fetched.fingerprint
            options.onServerKeyChange?.(pin)
          }
        }
        let opened: Channel
        try {
          opened = await openChannel({ fetch: fetchImpl, baseUrl, serverKeys })
        } catch (error) {
          // The cached keys may have been retired by a rotation: fetch the bundle again, once.
          if (!(error instanceof ProtocolError) || error.code !== 'handshake-failed') throw error
          const fetched = await fetchServerKeys(fetchImpl, baseUrl, pin)
          serverKeys = fetched.keys
          if (fetched.fingerprint !== pin) {
            pin = fetched.fingerprint
            options.onServerKeyChange?.(pin)
          }
          opened = await openChannel({ fetch: fetchImpl, baseUrl, serverKeys })
        }
        if (login) await certify(opened, login)
        channel = opened
        return opened
      }

    /** Send one request, retrying once on a new channel when the server ended the old one. */
    const send =
      async (method: string, path: string, headers: [string, string][], body: Uint8Array): Promise<ChannelResponse> => {
        for (let attempt = 0; ; attempt++) {
          const target = await ensureChannel()
          const state = login
          try {
            return await target.send(
              { method, path, headers, body
              , sign: state
                  ? (n, parts) =>
                      ed25519Sign(
                        requestMessage({ h: target.handshakeHash, sid: target.sid, n, ...parts })
                        , state.sessionPrivate)
                  : undefined })
          } catch (error) {
            const retry =
              error instanceof ProtocolError
              && (error.code === 'channel-ended' || error.code === 'counter-rejected')
            if (!retry || attempt > 0) throw error
            channel = undefined
          }
        }
      }

    const sendJson =
      async (method: string, path: string, value?: unknown, type = JSON_API) =>
        send(method, path
          , value === undefined ? [['accept', JSON_API]] : [['accept', JSON_API], ['content-type', type]]
          , value === undefined ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(value)))

    const expectJson =
      async <T>(response: Promise<ChannelResponse>): Promise<T> => {
        const result = await response
        if (result.status < 200 || result.status >= 300) throw failure(result)
        return result.json<T>() as T
      }

    /**
     * Run a fresh OPAQUE registration for this user on the given route pair,
     * with a new identity key and its proof, for a re-key or a reset.
     */
    const registerIdentity =
      async (target: Channel, route: string, startBody: Record<string, unknown>, password: string, username: string) => {
        const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password })
        const started =
          await expectJson<{ id: string, userId?: string, registrationResponse: string }>(
            sendJson('POST', route, { ...startBody, registrationRequest }, JSON_TYPE))
        const { registrationRecord, exportKey } =
          opaque.client.finishRegistration({ clientRegistrationState, registrationResponse: started.registrationResponse, password })
        return { started, registrationRecord, exportKey, finishIdentity: (userId: string) => {
          const identityPrivate = randomBytes(32)
          const identityPublic = ed25519PublicKey(identityPrivate)
          const id = uuidBytes(userId)
          return (
            { identityPrivate, identityPublic
            , body:
                { registrationRecord
                , identityPublic: bytesToBase64Url(identityPublic)
                , wrappedIdentity: bytesToBase64Url(wrapIdentity(
                    { exportKey: base64UrlToBytes(exportKey), userId: id, identityPublic, identityPrivate, nonce: randomBytes(24) }))
                , proof: bytesToBase64Url(ed25519Sign(
                    registrationProofMessage(target.handshakeHash, id, username.toLowerCase(), identityPublic), identityPrivate)) } })
        } }
      }

    const doLogin =
      async (input: { username: string, password: string, newPassword?: string }): Promise<SecureLogin> => {
        await opaque.ready
        // A login always starts on a fresh, unauthenticated channel.
        channel = undefined
        login = undefined
        const target = await ensureChannel()
        const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password: input.password })
        const started =
          await expectJson<{ id: string, loginResponse: string }>(
            sendJson('POST', '/account/login', { username: input.username, startLoginRequest }, JSON_TYPE))
        const finished =
          opaque.client.finishLogin({ clientLoginState, loginResponse: started.loginResponse, password: input.password })
        // A wrong password is detected here; the server is still told, so it counts the failure.
        const sessionKey = finished ? base64UrlToBytes(finished.sessionKey) : randomBytes(64)
        const result =
          await expectJson<{ loginId: string, userId: string, expiresAt: string, identityPublic: string | null, wrappedIdentity: string | null }>(
            sendJson('PUT', `/account/login/${started.id}`
              , { finishLoginRequest: finished?.finishLoginRequest ?? startLoginRequest
                , binder: bytesToBase64Url(loginBinder(sessionKey, target.handshakeHash, target.sid)) }
              , JSON_TYPE))
        if (!finished) throw new ResourceServerError(401, 'Unauthorized', 'Invalid username or password')

        let identityPublic: Uint8Array
        let identityPrivate: Uint8Array
        if (!result.identityPublic || !result.wrappedIdentity) {
          // The identity key was revoked: re-key, changing the password in the same step.
          if (!input.newPassword)
            throw new ResourceServerError(409, 'Conflict', 'This account must set a new password and identity key; pass newPassword')
          const fresh = await registerIdentity(target, '/account/rekey', {}, input.newPassword, input.username)
          const made = fresh.finishIdentity(result.userId)
          await expectJson(sendJson('PUT', `/account/rekey/${fresh.started.id}`, made.body, JSON_TYPE))
          identityPublic = made.identityPublic
          identityPrivate = made.identityPrivate
        } else {
          identityPublic = base64UrlToBytes(result.identityPublic)
          identityPrivate =
            unwrapIdentity(
              { exportKey: base64UrlToBytes(finished.exportKey), userId: uuidBytes(result.userId)
              , identityPublic, wrapped: base64UrlToBytes(result.wrappedIdentity) })
        }
        const state: LoginState =
          { userId: result.userId, loginId: result.loginId, expiresAt: result.expiresAt
          , identityPrivate, identityPublic, sessionPrivate: new Uint8Array(32) }
        await certify(target, state)
        login = state
        return { userId: state.userId, loginId: state.loginId, expiresAt: state.expiresAt }
      }

    return (
      { register: async (input, registerOptions = {}) => {
          await opaque.ready
          const target = await ensureChannel()
          const username = input.username.toLowerCase()
          const { clientRegistrationState, registrationRequest } =
            opaque.client.startRegistration({ password: input.password })
          const started =
            await expectJson<{ id: string, userId: string, registrationResponse: string }>(
              sendJson('POST', '/account/registration'
                , { username, registrationRequest, ...(input.displayName ? { displayName: input.displayName } : {}) }
                , JSON_TYPE))
          const { registrationRecord, exportKey } =
            opaque.client.finishRegistration(
              { clientRegistrationState, registrationResponse: started.registrationResponse, password: input.password })

          const identityPrivate = randomBytes(32)
          const identityPublic = ed25519PublicKey(identityPrivate)
          const userId = uuidBytes(started.userId)
          const wrapped =
            wrapIdentity(
              { exportKey: base64UrlToBytes(exportKey), userId, identityPublic, identityPrivate
              , nonce: randomBytes(24) })
          const proof =
            ed25519Sign(registrationProofMessage(target.handshakeHash, userId, username, identityPublic), identityPrivate)
          await expectJson(
            sendJson('PUT', `/account/registration/${started.id}`
              , { registrationRecord
                , identityPublic: bytesToBase64Url(identityPublic)
                , wrappedIdentity: bytesToBase64Url(wrapped)
                , proof: bytesToBase64Url(proof) }
              , JSON_TYPE))
          if (registerOptions.signIn !== false) await doLogin(input)
          return { userId: started.userId }
        }
      , login: doLogin
      , changePassword: async (newPassword, changeOptions = {}) => {
          await opaque.ready
          const state = login
          if (!state) throw new ResourceServerError(401, 'Unauthorized', 'Log in first')
          const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password: newPassword })
          const started =
            await expectJson<{ id: string, registrationResponse: string }>(
              sendJson('POST', '/account/password', { registrationRequest }, JSON_TYPE))
          const { registrationRecord, exportKey } =
            opaque.client.finishRegistration({ clientRegistrationState, registrationResponse: started.registrationResponse, password: newPassword })
          // The same identity key, wrapped under the new password.
          const wrapped =
            wrapIdentity(
              { exportKey: base64UrlToBytes(exportKey), userId: uuidBytes(state.userId)
              , identityPublic: state.identityPublic, identityPrivate: state.identityPrivate, nonce: randomBytes(24) })
          const response =
            await sendJson('PUT', `/account/password/${started.id}`
              , { registrationRecord, wrappedIdentity: bytesToBase64Url(wrapped)
                , ...(changeOptions.keepOtherLogins ? { keepOtherLogins: true } : {}) }
              , JSON_TYPE)
          if (response.status !== 204) throw failure(response)
        }
      , logins: async () =>
          (await expectJson<{ logins: { id: string, createdAt: string, expiresAt: string, current: boolean }[] }>(
            sendJson('GET', '/account/logins'))).logins
      , endLogin: async id => {
          const response = await sendJson('DELETE', id === 'others' ? '/account/logins?others=true' : `/account/logins/${id}`)
          if (response.status !== 204) throw failure(response)
        }
      , revokeIdentity: async () => {
          const response = await sendJson('POST', '/account/identity/revoke')
          login = undefined
          channel = undefined
          if (response.status !== 204) throw failure(response)
        }
      , redeemReset: async input => {
          await opaque.ready
          login = undefined
          channel = undefined
          const target = await ensureChannel()
          const fresh = await registerIdentity(target, '/account/reset', { token: input.token }, input.newPassword, input.username)
          const made = fresh.finishIdentity(fresh.started.userId!)
          await expectJson(sendJson('PUT', `/account/reset/${fresh.started.id}`, made.body, JSON_TYPE))
          return doLogin({ username: input.username, password: input.newPassword })
        }
      , admin:
          { issueReset: userId =>
              expectJson(sendJson('POST', '/account/resets', { userId }, JSON_TYPE))
          , setDisabled: async (userId, disabled) => {
              const response = await sendJson('POST', `/account/users/${userId}/${disabled ? 'disable' : 'enable'}`)
              if (response.status !== 204) throw failure(response)
            }
          , revoke: async userId => {
              const response = await sendJson('POST', `/account/users/${userId}/revoke`)
              if (response.status !== 204) throw failure(response)
            }
          }
      , logout: async () => {
          try {
            if (login && channel) await send('DELETE', '/account/login/current', [], new Uint8Array(0))
          } finally {
            login = undefined
            channel = undefined
          }
        }
      , request: async (path, init = {}) => {
          const body =
            typeof init.body === 'string' ? new TextEncoder().encode(init.body) : init.body ?? new Uint8Array(0)
          return send(
            (init.method ?? 'GET').toUpperCase(), path
            , Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v] as [string, string]), body)
        }
      , get: path => expectJson(sendJson('GET', path))
      , post: (path, body) => expectJson(sendJson('POST', path, body))
      , patch: (path, body) => expectJson(sendJson('PATCH', path, body))
      , put: (path, body) => expectJson(sendJson('PUT', path, body))
      , delete: async path => {
          const response = await sendJson('DELETE', path)
          if (response.status < 200 || response.status >= 300) throw failure(response)
        }
      , get currentLogin() {
          return login ? { userId: login.userId, loginId: login.loginId, expiresAt: login.expiresAt } : null
        }
      , get isSignedIn() {
          return login !== undefined
        }
      })
  }
