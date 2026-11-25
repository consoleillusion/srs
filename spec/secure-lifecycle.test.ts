import { describe, expect, test } from 'bun:test'
import { createServerKeys } from '../src/auth/server-keys.ts'
import { createSecureClient } from '../src/client/secure.ts'
import { verifyRetainedSignatures } from '../src/db/verify-signatures.ts'
import { createApp } from '../src/server/app/index.ts'
import { createRowDatabase } from '../src/server/database.ts'
import { createTestServer, opaqueServerSetup } from './helpers/test-server.ts'

const PASSWORD = 'correct horse battery staple'
const NEW_PASSWORD = 'a different long passphrase'
const note = (title: string) => ({ data: { type: 'note', attributes: { title } } })

const setup =
  async (options: { allowReset?: boolean } = {}) => {
    const { built, db, connection } = await createTestServer({ session: true })
    const { keys } = createServerKeys()
    const app = createApp({ built, db, opaqueServerSetup, requireSession: true, serverKeys: keys, admins: ['root'], ...options })
    const fetch = (url: string | URL | Request, init?: RequestInit) => Promise.resolve(app.request(String(url), init))
    const client = () => createSecureClient({ baseUrl: 'http://localhost', serverKey: keys.fingerprint, fetch })
    const verify = () => verifyRetainedSignatures(createRowDatabase(connection))
    return { client, verify }
  }

describe('logout and devices', () => {
  test('lists logins and ends one, which stops that device', async () => {
    const { client } = await setup()
    const laptop = client()
    const phone = client()
    await laptop.register({ username: 'alice', password: PASSWORD })
    await phone.login({ username: 'alice', password: PASSWORD })

    const logins = await laptop.logins()
    expect(logins).toHaveLength(2)
    expect(logins.filter(x => x.current)).toHaveLength(1)

    await laptop.endLogin(phone.currentLogin!.loginId)
    // The phone's channel was dropped; resuming with an ended login is refused.
    await expect(phone.post('/note', note('x'))).rejects.toMatchObject({ status: 401 })
    expect((await laptop.post<{ data: { id: string } }>('/note', note('still here'))).data.id).toBeDefined()
  })

  test('ends every other login', async () => {
    const { client } = await setup()
    const a = client(), b = client(), c = client()
    await a.register({ username: 'alice', password: PASSWORD })
    await b.login({ username: 'alice', password: PASSWORD })
    await c.login({ username: 'alice', password: PASSWORD })
    await a.endLogin('others')
    expect(await a.logins()).toHaveLength(1)
  })

  test('logout ends the login on the server', async () => {
    const { client } = await setup()
    const a = client()
    await a.register({ username: 'alice', password: PASSWORD })
    const other = client()
    await other.login({ username: 'alice', password: PASSWORD })
    await a.logout()
    expect(a.isSignedIn).toBe(false)
    expect(await other.logins()).toHaveLength(1)
  })
})

describe('password change', () => {
  test('the new password works, the old does not, and old signatures stay valid', async () => {
    const { client, verify } = await setup()
    const alice = client()
    await alice.register({ username: 'alice', password: PASSWORD })
    await alice.post('/note', note('before'))
    await alice.changePassword(NEW_PASSWORD)
    await alice.post('/note', note('after'))

    await expect(client().login({ username: 'alice', password: PASSWORD })).rejects.toMatchObject({ status: 401 })
    await client().login({ username: 'alice', password: NEW_PASSWORD })
    const results = await verify()
    expect(results).toHaveLength(2)
    expect(results.every(x => x.valid)).toBe(true)
  })
})

describe('revocation', () => {
  test('ends every login and forces a re-key with a new password', async () => {
    const { client, verify } = await setup()
    const alice = client()
    await alice.register({ username: 'alice', password: PASSWORD })
    await alice.post('/note', note('before revocation'))
    const other = client()
    await other.login({ username: 'alice', password: PASSWORD })

    await alice.revokeIdentity()
    await expect(other.post('/note', note('x'))).rejects.toMatchObject({ status: 401 })
    await expect(client().login({ username: 'alice', password: PASSWORD })).rejects.toMatchObject({ status: 409 })

    const again = client()
    await again.login({ username: 'alice', password: PASSWORD, newPassword: NEW_PASSWORD })
    await again.post('/note', note('after re-key'))
    await expect(client().login({ username: 'alice', password: PASSWORD })).rejects.toMatchObject({ status: 401 })

    const results = await verify()
    expect(results.every(x => x.valid)).toBe(true)
    expect(results.find(x => x.reason)?.reason).toBe('made before its identity key was revoked')
  })
})

describe('admin reset and disabling', () => {
  test('an admin reset gives the user a new password and identity key; the token works once', async () => {
    const { client, verify } = await setup()
    const root = client()
    await root.register({ username: 'root', password: PASSWORD })
    const bob = client()
    const { userId } = await bob.register({ username: 'bob', password: PASSWORD })
    await bob.post('/note', note('bob before reset'))

    const { token } = await root.admin.issueReset(userId)
    const restored = client()
    await restored.redeemReset({ username: 'bob', token, newPassword: NEW_PASSWORD })
    await restored.post('/note', note('bob after reset'))
    await expect(client().redeemReset({ username: 'bob', token, newPassword: PASSWORD })).rejects.toMatchObject({ status: 401 })
    await expect(client().login({ username: 'bob', password: PASSWORD })).rejects.toMatchObject({ status: 401 })

    // Signatures by the retired key stay valid.
    expect((await verify()).every(x => x.valid)).toBe(true)
  })

  test('only an admin can issue resets, and resets can be turned off', async () => {
    const { client } = await setup()
    const bob = client()
    const { userId } = await bob.register({ username: 'bob', password: PASSWORD })
    await expect(bob.admin.issueReset(userId)).rejects.toMatchObject({ status: 403 })

    const off = await setup({ allowReset: false })
    const root = off.client()
    await root.register({ username: 'root', password: PASSWORD })
    await expect(root.admin.issueReset(userId)).rejects.toMatchObject({ status: 404 })
  })

  test('a disabled user is logged out and cannot log in until enabled', async () => {
    const { client } = await setup()
    const root = client()
    await root.register({ username: 'root', password: PASSWORD })
    const bob = client()
    const { userId } = await bob.register({ username: 'bob', password: PASSWORD })

    await root.admin.setDisabled(userId, true)
    await expect(bob.post('/note', note('x'))).rejects.toMatchObject({ status: 401 })
    await expect(client().login({ username: 'bob', password: PASSWORD })).rejects.toMatchObject({ status: 401 })
    await root.admin.setDisabled(userId, false)
    await client().login({ username: 'bob', password: PASSWORD })
  })

  test("an admin can revoke another user's identity key", async () => {
    const { client } = await setup()
    const root = client()
    await root.register({ username: 'root', password: PASSWORD })
    const bob = client()
    const { userId } = await bob.register({ username: 'bob', password: PASSWORD })
    await root.admin.revoke(userId)
    await expect(client().login({ username: 'bob', password: PASSWORD })).rejects.toMatchObject({ status: 409 })
  })
})
