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
  /** Log in with username and password. */
  login: (input: { username: string, password: string }) => Promise<SecureLogin>
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
        serverKeys ??= await fetchServerKeys(fetchImpl, baseUrl, options.serverKey)
        const opened = await openChannel({ fetch: fetchImpl, baseUrl, serverKeys })
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

    const doLogin =
      async (input: { username: string, password: string }): Promise<SecureLogin> => {
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
        if (!finished || !result.identityPublic || !result.wrappedIdentity)
          throw new ResourceServerError(401, 'Unauthorized', 'Invalid username or password')

        const identityPublic = base64UrlToBytes(result.identityPublic)
        const identityPrivate =
          unwrapIdentity(
            { exportKey: base64UrlToBytes(finished.exportKey), userId: uuidBytes(result.userId)
            , identityPublic, wrapped: base64UrlToBytes(result.wrappedIdentity) })
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
