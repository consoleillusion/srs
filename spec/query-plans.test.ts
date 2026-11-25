import { describe, expect, test } from 'bun:test'
import { createApp } from '../src/server/app/index.ts'
import { createRowDatabase, type RowDatabase } from '../src/server/database.ts'
import { signIn, resourceDocument, toMany, toOne } from './helpers/session.ts'
import { createTestServer, opaqueServerSetup } from './helpers/test-server.ts'

/**
 * Rows read cost money on hosted databases, so reading one row must not read
 * every row. These tests run real requests, then ask SQLite how it planned
 * each query they made, and fail on a full scan of a table where an index
 * lookup was possible (design book, Efficiency).
 */
const recording =
  (db: RowDatabase) => {
    const queries: { sql: string, params: unknown[] }[] = []
    const wrap: RowDatabase =
      { ...db
      , all: (sql, params = []) => { queries.push({ sql, params }); return db.all(sql, params) }
      , get: (sql, params = []) => { queries.push({ sql, params }); return db.get(sql, params) }
      }
    return { wrap, queries }
  }

const setup =
  async () => {
    const { built, db, connection } = await createTestServer({ session: true })
    const { wrap, queries } = recording(db)
    const app = createApp({ built, db: wrap, opaqueServerSetup, requireSession: true })
    /** The plan lines of every SELECT made since the last call, for one table. */
    const scansSince =
      async (from: number) => {
        const scans: string[] = []
        for (const { sql, params } of queries.slice(from)) {
          if (!/^\s*SELECT/i.test(sql)) continue
          const plan = await (await connection.prepare(`EXPLAIN QUERY PLAN ${sql}`)).all(...params) as { detail: string }[]
          for (const { detail } of plan)
            // A full scan of a stored table (not of a view, a constant row or a temporary b-tree).
            if (/^SCAN (?!.*_view\b)(?!CONSTANT)\w+( AS \w+)?$/.test(detail)) scans.push(`${detail}  <=  ${sql.slice(0, 120)}`)
        }
        return scans
      }
    return { app, queries, scansSince, db }
  }

describe('query plans', () => {
  test('reading, changing and deleting one row never scans a table', async () => {
    const { app, queries, scansSince } = await setup()
    const alice = await signIn(app, 'alice')
    const tag = ((await (await alice.request('POST', '/tag', resourceDocument('tag', { name: 't' }))).json()) as any).data.id
    for (let i = 0; i < 5; i++)
      await alice.request('POST', '/article', resourceDocument('article', { heading: `Article ${i}` }, { tag: toMany('tag', [tag]) }))
    const id = ((await (await alice.request('POST', '/article', resourceDocument('article', { heading: 'Target' }))).json()) as any).data.id
    const from = queries.length
    expect((await alice.request('GET', `/article/${id}`)).status).toBe(200)
    expect((await alice.request('GET', `/article/${id}?include=tag`)).status).toBe(200)
    expect((await alice.request('PATCH', `/article/${id}`, { data: { type: 'article', id, attributes: { heading: 'Changed' } } })).status).toBe(200)
    expect((await alice.request('GET', `/article/${id}/relationships/tag`)).status).toBe(200)
    expect((await alice.request('DELETE', `/article/${id}`)).status).toBe(204)
    expect(await scansSince(from)).toEqual([])
  })

  test('shared rows and inherited access are checked by index', async () => {
    const { app, queries, scansSince } = await setup()
    const alice = await signIn(app, 'alice')
    const bob = await signIn(app, 'bob')
    const note = ((await (await alice.request('POST', '/note', resourceDocument('note', { title: 'N', visibility: 'shared' }))).json()) as any).data.id
    await alice.request('POST', '/note_share', resourceDocument('note_share', { can_read: true }, { note: toOne('note', note), user: toOne('user', bob.userId) }))
    const chat = ((await (await alice.request('POST', '/chat', resourceDocument('chat', { name: 'C', visibility: 'shared' }))).json()) as any).data.id
    const message = ((await (await alice.request('POST', '/message', resourceDocument('message', { text: 'hi' }, { chat: toOne('chat', chat) }))).json()) as any).data.id
    await alice.request('POST', '/chat_share', resourceDocument('chat_share', { can_read: true }, { chat: toOne('chat', chat), user: toOne('user', bob.userId) }))
    const from = queries.length
    expect((await bob.request('GET', `/note/${note}`)).status).toBe(200)
    expect((await bob.request('GET', `/message/${message}`)).status).toBe(200)
    expect(await scansSince(from)).toEqual([])
  })

  test('page[total]=false skips the count and still says whether there is a next page', async () => {
    const { app, queries } = await setup()
    const alice = await signIn(app, 'alice')
    for (let i = 0; i < 3; i++) await alice.request('POST', '/article', resourceDocument('article', { heading: `Article ${i}` }))
    const from = queries.length
    const first = await (await alice.request('GET', '/article?page[size]=2&page[total]=false')).json() as any
    expect(queries.slice(from).some(x => x.sql.includes('COUNT('))).toBe(false)
    expect(first.data).toHaveLength(2)
    expect(first.meta.page).toEqual({ number: 1, size: 2 })
    expect(first.links.next).toContain('page%5Bnumber%5D=2')
    expect(first.links.last).toBeUndefined()
    const second = await (await alice.request('GET', '/article?page[size]=2&page[number]=2&page[total]=false')).json() as any
    expect(second.data).toHaveLength(1)
    expect(second.links.next).toBeNull()
    expect((await alice.request('GET', '/article?page[total]=maybe')).status).toBe(400)
  })

  test('a related collection reads the related rows by key', async () => {
    const { app, queries, scansSince } = await setup()
    const alice = await signIn(app, 'alice')
    const tags: string[] = []
    for (let i = 0; i < 3; i++)
      tags.push(((await (await alice.request('POST', '/tag', resourceDocument('tag', { name: `t${i}` }))).json()) as any).data.id)
    const article = ((await (await alice.request('POST', '/article', resourceDocument('article', { heading: 'Article A' }, { tag: toMany('tag', tags) }))).json()) as any).data.id
    const from = queries.length
    const related = await (await alice.request('GET', `/article/${article}/tag?page[total]=false`)).json() as any
    expect(related.data).toHaveLength(3)
    expect(await scansSince(from)).toEqual([])
  })
})
