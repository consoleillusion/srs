import { describe, expect, test } from 'bun:test'
import * as opaque from '@serenity-kit/opaque'
import { createServerKeys } from '../src/auth/server-keys.ts'
import { openChannel } from '../src/client/channel.ts'
import { base64UrlToBytes, bytesToBase64Url, ed25519PublicKey, ed25519Sign, ed25519Verify, randomBytes } from '../src/client/crypto.ts'
import { createSecureClient } from '../src/client/secure.ts'
import { loginBinder, registrationProofMessage, signCertificate, verifyCertificate, wrapIdentity } from '../src/protocol/accounts.ts'
import { decodeCertificate } from '../src/protocol/encoding.ts'
import { createApp } from '../src/server/app/index.ts'
import { verifyRetainedSignatures } from '../src/db/verify-signatures.ts'
import { createRowDatabase } from '../src/server/database.ts'
import { createTestServer, JSON_API, opaqueServerSetup } from './helpers/test-server.ts'

const PASSWORD = 'correct horse battery staple'

/** A Noise server, and a function that starts it again on the same database and keys. */
const setup =
  async () => {
    const { built, db, connection } = await createTestServer({ session: true })
    const { keys } = createServerKeys()
    let app = createApp({ built, db, opaqueServerSetup, requireSession: true, serverKeys: keys })
    const fetch = (url: string | URL | Request, init?: RequestInit) => Promise.resolve(app.request(String(url), init))
    const restart = () => {
      app = createApp({ built, db, opaqueServerSetup, requireSession: true, serverKeys: keys })
    }
    const client = () => createSecureClient({ baseUrl: 'http://localhost', serverKey: keys.fingerprint, fetch })
    const verify = () => verifyRetainedSignatures(createRowDatabase(connection))
    const rows = async (sql: string, params: unknown[] = []) => (await (await connection.prepare(sql)).all(...params)) as Record<string, unknown>[]
    return { keys, fetch, restart, client, rows, verify, connection }
  }

const note = (title: string) => ({ data: { type: 'note', attributes: { title } } })

describe('accounts over the Noise transport', () => {
  test('register, log in, and make signed requests', async () => {
    const { client } = await setup()
    const alice = client()
    const { userId } = await alice.register({ username: 'Alice', password: PASSWORD })
    expect(alice.isSignedIn).toBe(true)
    expect(alice.currentLogin?.userId).toBe(userId)
    const me = await alice.get<{ data: { id: string, attributes: { username: string } } }>(`/user/${userId}`)
    expect(me.data.attributes.username).toBe('alice')
    const created = await alice.post<{ data: { id: string } }>('/note', note('hello'))
    expect(created.data.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('a signed write is retained and verifiable from the database alone', async () => {
    const { client, rows } = await setup()
    const alice = client()
    await alice.register({ username: 'alice', password: PASSWORD })
    const created = await alice.post<{ data: { id: string } }>('/note', note('signed content'))

    const [audit] = await rows("SELECT signature, certificate_id, signed_message, body FROM audit_log WHERE action = 'create' AND resource = 'note'")
    expect(audit).toBeDefined()
    expect(String(audit!.body)).toContain('signed content')
    const [cert] = await rows("SELECT material FROM key WHERE id = ? AND type = 'certificate'", [audit!.certificate_id])
    const stored = JSON.parse(String(cert!.material)) as { certificate: string, signature: string, identityKey: string }
    const [identity] = await rows("SELECT jwk FROM key WHERE type = 'identity'")
    const identityPublic = base64UrlToBytes(JSON.parse(String(identity!.jwk)).x)

    // 1. The certificate was signed by the user's identity key.
    expect(verifyCertificate(identityPublic, base64UrlToBytes(stored.certificate), base64UrlToBytes(stored.signature))).toBe(true)
    // 2. The request was signed by the certified session key.
    const sessionPublic = decodeCertificate(base64UrlToBytes(stored.certificate)).sessionPublic
    expect(ed25519Verify(base64UrlToBytes(String(audit!.signature)), base64UrlToBytes(String(audit!.signed_message)), sessionPublic)).toBe(true)
    // 3. The signed message covers this body.
    const digest = new Bun.CryptoHasher('sha256').update(String(audit!.body)).digest()
    expect(Buffer.from(base64UrlToBytes(String(audit!.signed_message))).includes(Buffer.from(digest))).toBe(true)
    expect(created.data.id).toBeDefined()
  })

  test('a wrong password is refused', async () => {
    const { client } = await setup()
    await client().register({ username: 'alice', password: PASSWORD }, { signIn: false })
    await expect(client().login({ username: 'alice', password: 'wrong password' })).rejects.toMatchObject({ status: 401 })
  })

  test('an unknown username gets the same login start answer as a known one', async () => {
    const { fetch, keys, client } = await setup()
    await client().register({ username: 'alice', password: PASSWORD }, { signIn: false })
    await opaque.ready
    const shape = async (username: string) => {
      const channel = await openChannel({ fetch, baseUrl: 'http://localhost', serverKeys: keys })
      const { startLoginRequest } = opaque.client.startLogin({ password: PASSWORD })
      const response = await channel.send(
        { method: 'POST', path: '/account/login', headers: [['content-type', 'application/json']]
        , body: new TextEncoder().encode(JSON.stringify({ username, startLoginRequest })) })
      return { status: response.status, keys: Object.keys(response.json<object>() ?? {}).sort() }
    }
    expect(await shape('nobody')).toEqual(await shape('alice'))
  })

  test('the session survives a server restart without the password', async () => {
    const { client, restart } = await setup()
    const alice = client()
    await alice.register({ username: 'alice', password: PASSWORD })
    await alice.post('/note', note('before'))
    restart()
    const after = await alice.post<{ data: { id: string } }>('/note', note('after'))
    expect(after.data.id).toBeDefined()
  })

  test('the account routes do not exist outside a channel', async () => {
    const { keys } = await setup()
    const { built, db } = await createTestServer({ session: true })
    const bearer = createApp({ built, db, opaqueServerSetup, requireSession: true, serverKeys: keys, transport: 'bearer' })
    expect((await bearer.request('/account/login', { method: 'POST', body: '{}' })).status).toBe(404)
  })
})

describe('the offline signature verifier', () => {
  test('accepts genuine signatures and catches an altered body', async () => {
    const { client, verify, connection } = await setup()
    const alice = client()
    await alice.register({ username: 'alice', password: PASSWORD })
    await alice.post('/note', note('one'))
    await alice.post('/note', note('two'))
    const results = await verify()
    expect(results).toHaveLength(2)
    expect(results.every(x => x.valid)).toBe(true)

    // Someone with write access to the database file edits a retained body.
    await connection.exec('DROP TRIGGER audit_log_no_update')
    await connection.exec("UPDATE audit_log SET body = replace(body, 'two', 'three') WHERE body LIKE '%two%'")
    const after = await verify()
    expect(after.filter(x => !x.valid).map(x => x.reason)).toEqual(['retained body does not match the signed hash'])
  })
})

describe('attacks on accounts', () => {
  /** Run registration by hand so its messages can be altered. */
  const register =
    async (fetch: ReturnType<Awaited<ReturnType<typeof setup>>['fetch']> extends never ? never : any, keys: any, alter: (body: Record<string, string>) => void) => {
      await opaque.ready
      const channel = await openChannel({ fetch, baseUrl: 'http://localhost', serverKeys: keys })
      const send = (method: string, path: string, value: unknown) =>
        channel.send({ method, path, headers: [['content-type', 'application/json']], body: new TextEncoder().encode(JSON.stringify(value)) })
      const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password: PASSWORD })
      const started = (await send('POST', '/account/registration', { username: 'mallory', registrationRequest })).json<any>()
      const { registrationRecord, exportKey } =
        opaque.client.finishRegistration({ clientRegistrationState, registrationResponse: started.registrationResponse, password: PASSWORD })
      const identityPrivate = randomBytes(32)
      const identityPublic = ed25519PublicKey(identityPrivate)
      const userId = Buffer.from(started.userId.replaceAll('-', ''), 'hex')
      const body: Record<string, string> =
        { registrationRecord
        , identityPublic: bytesToBase64Url(identityPublic)
        , wrappedIdentity: bytesToBase64Url(wrapIdentity({ exportKey: base64UrlToBytes(exportKey), userId, identityPublic, identityPrivate, nonce: randomBytes(24) }))
        , proof: bytesToBase64Url(ed25519Sign(registrationProofMessage(channel.handshakeHash, userId, 'mallory', identityPublic), identityPrivate)) }
      alter(body)
      return (await send('PUT', `/account/registration/${started.id}`, body)).status
    }

  test('registering a public key without its private key is refused', async () => {
    const { fetch, keys } = await setup()
    expect(await register(fetch, keys, body => { body.identityPublic = bytesToBase64Url(ed25519PublicKey(randomBytes(32))) })).toBe(400)
    expect(await register(fetch, keys, () => undefined)).toBe(201)
  })

  test('a login relayed through another channel is refused', async () => {
    const { fetch, keys, client } = await setup()
    await client().register({ username: 'alice', password: PASSWORD }, { signIn: false })
    await opaque.ready
    // The attacker runs the server side of the user's login in their own channel:
    // the binder the user computes names the user's channel, not the attacker's.
    const victim = await openChannel({ fetch, baseUrl: 'http://localhost', serverKeys: keys })
    const attacker = await openChannel({ fetch, baseUrl: 'http://localhost', serverKeys: keys })
    const send = (channel: typeof victim, method: string, path: string, value: unknown) =>
      channel.send({ method, path, headers: [['content-type', 'application/json']], body: new TextEncoder().encode(JSON.stringify(value)) })
    const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password: PASSWORD })
    const started = (await send(attacker, 'POST', '/account/login', { username: 'alice', startLoginRequest })).json<any>()
    const finished = opaque.client.finishLogin({ clientLoginState, loginResponse: started.loginResponse, password: PASSWORD })!
    const binder = loginBinder(base64UrlToBytes(finished.sessionKey), victim.handshakeHash, victim.sid)
    const relayed = await send(attacker, 'PUT', `/account/login/${started.id}`, { finishLoginRequest: finished.finishLoginRequest, binder: bytesToBase64Url(binder) })
    expect(relayed.status).toBe(401)
  })

  test('a certificate for another channel, or signed by another key, is refused', async () => {
    const { fetch, keys, client } = await setup()
    await client().register({ username: 'alice', password: PASSWORD }, { signIn: false })
    await opaque.ready
    const channel = await openChannel({ fetch, baseUrl: 'http://localhost', serverKeys: keys })
    const other = await openChannel({ fetch, baseUrl: 'http://localhost', serverKeys: keys })
    const send = (method: string, path: string, value: unknown) =>
      channel.send({ method, path, headers: [['content-type', 'application/json']], body: new TextEncoder().encode(JSON.stringify(value)) })
    const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password: PASSWORD })
    const started = (await send('POST', '/account/login', { username: 'alice', startLoginRequest })).json<any>()
    const finished = opaque.client.finishLogin({ clientLoginState, loginResponse: started.loginResponse, password: PASSWORD })!
    const login = (await send('PUT', `/account/login/${started.id}`,
      { finishLoginRequest: finished.finishLoginRequest
      , binder: bytesToBase64Url(loginBinder(base64UrlToBytes(finished.sessionKey), channel.handshakeHash, channel.sid)) })).json<any>()
    expect(login.loginId).toBeDefined()

    const certify = (identityPrivate: Uint8Array, target: typeof channel) => {
      const now = Date.now()
      const signed = signCertificate(identityPrivate,
        { userId: Buffer.from(login.userId.replaceAll('-', ''), 'hex'), loginId: Buffer.from(login.loginId.replaceAll('-', ''), 'hex')
        , sid: target.sid, h: target.handshakeHash, sessionPublic: ed25519PublicKey(randomBytes(32)), issuedAt: now, expiresAt: now + 60_000 })
      return send('POST', '/account/session', { certificate: bytesToBase64Url(signed.certificate), signature: bytesToBase64Url(signed.signature) })
    }
    // Signed by a key that is not the user's identity key.
    expect((await certify(randomBytes(32), channel)).status).toBe(401)
    // Naming a different channel: the attacker cannot reuse a certificate seen elsewhere.
    const { unwrapIdentity } = await import('../src/protocol/accounts.ts')
    const identityPrivate = unwrapIdentity(
      { exportKey: base64UrlToBytes(finished.exportKey), userId: Buffer.from(login.userId.replaceAll('-', ''), 'hex')
      , identityPublic: base64UrlToBytes(login.identityPublic), wrapped: base64UrlToBytes(login.wrappedIdentity) })
    expect((await certify(identityPrivate, other)).status).toBe(401)
    expect((await certify(identityPrivate, channel)).status).toBe(201)

    // The channel is now logged in: a request without a signature, or signed by
    // some other key, is refused before it reaches the app.
    const read = { method: 'GET', path: `/user/${login.userId}`, headers: [['accept', JSON_API]] as [string, string][] }
    expect((await channel.send(read)).status).toBe(401)
    expect((await channel.send({ ...read, sign: () => ed25519Sign(new Uint8Array(1), randomBytes(32)) })).status).toBe(401)
  })

})
