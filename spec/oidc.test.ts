import { describe, expect, test } from 'bun:test'
import { generateKeyPair, SignJWT } from 'jose'
import { createOidcVerifier } from '../src/auth/oidc.ts'
import { rolesOf } from '../src/server/app/guard.ts'
import { createRowDatabase } from '../src/server/database.ts'
import { signIn } from './helpers/session.ts'
import { createTestServer, JSON_API } from './helpers/test-server.ts'

const ISSUER = 'https://idp.example.test'
const AUDIENCE = 'srs-api'

const signing = await generateKeyPair('ES256')
const other = await generateKeyPair('ES256')

/** Sign a token with sensible defaults that each test can override. */
const token =
  async (claims: Record<string, unknown> = {}, options: { key?: CryptoKey, issuer?: string, audience?: string, expires?: string } = {}) => {
    // Purpose: mint a signed test token for the fake identity provider
    return await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(String(claims.sub ?? 'subject-1'))
      .setIssuer(options.issuer ?? ISSUER)
      .setAudience(options.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(options.expires ?? '5m')
      .sign(options.key ?? signing.privateKey)
  }

/** Run a query on the test connection and return every row. */
const rows =
  async (connection: { prepare: (sql: string) => Promise<{ all: () => Promise<unknown[]> }> }, sql: string) => {
    // Purpose: run one SELECT against the test database and return its rows
    return await (await connection.prepare(sql)).all()
  }

const verifier = () => createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE, keys: async () => signing.publicKey })

const setup =
  async (extra: { oidcAdmins?: string[] } = {}) => {
    // Purpose: start a session-enforcing server that trusts the fake identity provider
    const oidc = await verifier()
    return { oidc, ...(await createTestServer({ session: true, oidc, ...extra })) }
  }

const get = (app: any, bearer: string, path = '/article') =>
  app.request(path, { headers: { authorization: `Bearer ${bearer}`, accept: JSON_API } })

describe('bearer tokens from an identity provider', () => {
  test('accepts a valid token and creates the user once', async () => {
    const { app, connection } = await setup()
    const jwt = await token({ name: 'Alice Example' })
    expect((await get(app, jwt)).status).toBe(200)
    expect((await get(app, jwt)).status).toBe(200)

    const found = await rows(connection, 'SELECT username, display_name, oidc_issuer, oidc_subject FROM user')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ display_name: 'Alice Example', oidc_issuer: ISSUER, oidc_subject: 'subject-1' })
  })

  test('derives the username from the identity, not from a claim the user controls', async () => {
    const { app, connection } = await setup()
    await get(app, await token({ preferred_username: 'admin', email: 'admin@example.test' }))
    const [row] = await rows(connection, 'SELECT username FROM user') as any[]
    expect(row.username).toMatch(/^oidc-[0-9a-f]{32}$/)
  })

  test('stores an email only when the provider verified it', async () => {
    const { app, connection } = await setup()
    await get(app, await token({ sub: 'a', email: 'a@example.test', email_verified: false }))
    await get(app, await token({ sub: 'b', email: 'b@example.test', email_verified: true }))
    const found = await rows(connection, 'SELECT oidc_subject AS s, email FROM user ORDER BY oidc_subject') as any[]
    expect(found).toEqual([{ s: 'a', email: null }, { s: 'b', email: 'b@example.test' }])
  })

  test('keeps different subjects as different users', async () => {
    const { app, connection } = await setup()
    await get(app, await token({ sub: 'one' }))
    await get(app, await token({ sub: 'two' }))
    expect(await rows(connection, 'SELECT 1 FROM user')).toHaveLength(2)
  })

  test('rejects tokens that fail verification', async () => {
    const { app } = await setup()
    const bad =
      { 'wrong signing key': await token({}, { key: other.privateKey })
      , 'wrong issuer': await token({}, { issuer: 'https://evil.example.test' })
      , 'wrong audience': await token({}, { audience: 'another-api' })
      , expired: await token({}, { expires: '-5m' })
      , garbage: 'not.a.jwt'
      , 'unsigned token': `${btoa('{"alg":"none"}')}.${btoa(JSON.stringify({ sub: 'x', iss: ISSUER, aud: AUDIENCE, exp: 9999999999 }))}.`
      }
    for (const [name, jwt] of Object.entries(bad))
      expect({ name, status: (await get(app, jwt)).status }).toEqual({ name, status: 401 })
  })

  test('rejects a token with no expiry', async () => {
    const { app } = await setup()
    const jwt =
      await new SignJWT({}).setProtectedHeader({ alg: 'ES256' })
        .setSubject('s').setIssuer(ISSUER).setAudience(AUDIENCE).sign(signing.privateKey)
    expect((await get(app, jwt)).status).toBe(401)
  })

  test('does not create a user for a rejected token', async () => {
    const { app, connection } = await setup()
    await get(app, await token({}, { key: other.privateKey }))
    expect(await rows(connection, 'SELECT 1 FROM user')).toHaveLength(0)
  })

  test('refuses requests that need a signature', async () => {
    const { app } = await setup()
    const response =
      await app.request(
        '/payment'
        , { method: 'POST'
          , headers: { authorization: `Bearer ${await token()}`, 'content-type': JSON_API }
          , body: JSON.stringify({ data: { type: 'payment', attributes: {} } })
          })
    expect(response.status).toBe(401)
  })

  test('keeps built-in sessions working alongside a provider', async () => {
    const { app } = await setup()
    const alice = await signIn(app, 'alice')
    expect((await alice.request('GET', '/article')).status).toBe(200)
    expect((await get(app, '00000000-0000-4000-8000-000000000000')).status).toBe(401)
  })

  test('ignores JWT-shaped tokens when no provider is configured', async () => {
    const { app } = await createTestServer({ session: true })
    expect((await get(app, await token())).status).toBe(401)
  })
})

describe('admin by subject', () => {
  test('grants admin to a listed subject from the configured issuer only', async () => {
    const { app, connection, oidc } = await setup({ oidcAdmins: ['boss'] })
    await get(app, await token({ sub: 'boss' }))
    await get(app, await token({ sub: 'staff' }))
    const db = createRowDatabase(connection)
    const options = { db, registry: { get: () => ({}) } as never, adminNames: [], adminSubjects: ['boss'], oidcIssuer: oidc.issuer }
    const users = await rows(connection, 'SELECT id, oidc_subject AS s FROM user') as any[]
    const idOf = (s: string) => {
      const id = users.find(u => u.s === s).id as Uint8Array
      const hex = Buffer.from(id).toString('hex')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    }
    expect(await rolesOf(options, idOf('boss'))).toContain('admin')
    expect(await rolesOf(options, idOf('staff'))).not.toContain('admin')
    expect(await rolesOf({ ...options, oidcIssuer: 'https://other.example.test' }, idOf('boss'))).not.toContain('admin')
  })
})

describe('createOidcVerifier settings', () => {
  test('refuses an http issuer that is not localhost', async () => {
    await expect(createOidcVerifier({ issuer: 'http://idp.example.test', audience: 'x', keys: async () => signing.publicKey }))
      .rejects.toThrow('https')
  })

  test('allows an http issuer on localhost', async () => {
    await createOidcVerifier({ issuer: 'http://localhost:8080/realms/x', audience: 'x', keys: async () => signing.publicKey })
  })

  test('requires an audience', async () => {
    await expect(createOidcVerifier({ issuer: ISSUER, audience: '', keys: async () => signing.publicKey }))
      .rejects.toThrow('SRS_OIDC_AUDIENCE')
  })
})
