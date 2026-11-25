/**
 * A remote Turso database, chosen by `SRS_DATABASE_URL` and
 * `SRS_DATABASE_TOKEN` (design book, Implementation). It speaks to Turso over
 * `fetch`, so it runs where no local file can: serverless functions such as
 * Vercel's. With neither setting, SRS uses its embedded SQLite file.
 *
 * Foreign keys are off in every new SQLite session, and a remote session can be
 * replaced between requests, so each write turns them on first, and each
 * transaction runs on a fresh session that turns them on before it begins.
 *
 * @module
 */
import { connect, type Connection } from '@tursodatabase/serverless'
import type { Row, RowDatabase, RunResult } from '../server/database.ts'

/** Where the remote database is, from the environment, or undefined for the embedded file. */
export const remoteSettings =
  (env: Record<string, string | undefined> = process.env) => {
    const url = env.SRS_DATABASE_URL
    if (!url) return undefined
    if (!/^(libsql|https?|turso):\/\//.test(url))
      throw new Error(`SRS_DATABASE_URL must be a Turso URL (libsql://…), got "${url}"`)
    return { url, authToken: env.SRS_DATABASE_TOKEN }
  }

/** Settings for a remote database connection. */
export type RemoteSettings = NonNullable<ReturnType<typeof remoteSettings>>

/**
 * Open a connection to the remote database, for migrations and other commands.
 *
 * @param settings - URL and token.
 */
export const openRemote =
  (settings: RemoteSettings): Connection => connect({ url: settings.url, authToken: settings.authToken })

/**
 * The remote connection in the shape migrations use. Its prepared statements
 * take parameters as one array, unlike the embedded driver's, so statements
 * here bind through the connection instead.
 *
 * @param connection - A remote connection.
 */
export const migrationConnection =
  (connection: Connection) => (
    { exec: (sql: string) => connection.exec(sql) as Promise<unknown>
    , prepare: async (sql: string) => (
        { all: (...params: unknown[]) => connection.all(sql, ...params) as Promise<unknown[]>
        , run: (...params: unknown[]) => connection.run(sql, ...params) as Promise<unknown>
        })
    , close: () => connection.close()
    })

const FOREIGN_KEYS = 'PRAGMA foreign_keys = ON'

/**
 * Whether an error means the connection dropped before an answer came back,
 * rather than the database refusing the statement: a pooled socket the
 * server or platform had already closed, for example after a serverless
 * function was frozen between requests.
 */
export const isConnectionLost =
  (error: unknown): boolean => {
    const { code, message } = (error ?? {}) as { code?: unknown, message?: unknown }
    return (
      ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ConnectionClosed', 'ConnectionRefused', 'UND_ERR_SOCKET'].includes(String(code))
      || /socket connection was closed|socket hang up|fetch failed|network connection was lost/i.test(String(message)))
  }

/** How many times a statement or transaction is tried when the connection drops. */
const ATTEMPTS = 3

/**
 * Run `work`, and when the connection drops, wait a moment and run it again on
 * a fresh connection.
 *
 * @param work - What to do, given a connection.
 * @param fresh - Make a new connection after one drops.
 */
const retried =
  async <T>(work: () => Promise<T>, fresh: () => void): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await work()
      } catch (error) {
        if (attempt >= ATTEMPTS || !isConnectionLost(error)) throw error
        fresh()
        await new Promise(resolve => setTimeout(resolve, 50 * attempt))
      }
    }
  }

/** The row database over one connection: reads as they are, writes after turning foreign keys on. */
const rowsOver =
  (connection: Connection): RowDatabase => (
    { all: async (sql, params = []) => await connection.all(sql, ...params) as Row[]
    , get: async (sql, params = []) => await connection.get(sql, ...params) as Row | undefined
    , run: async (sql, params = []) => {
        await connection.exec(FOREIGN_KEYS)
        return await connection.run(sql, ...params) as RunResult
      }
    })

/**
 * A row database over the remote database.
 *
 * Statements outside a transaction share one connection. When it drops, the
 * statement runs again on a new one: a dropped request either never reached
 * the database or ran a statement whose repeat is harmless here (reads, and
 * the log and limit rows written outside transactions).
 *
 * A transaction gets a session of its own. When the connection drops before
 * COMMIT is sent, the database rolls the transaction back, so the whole
 * transaction runs again on a fresh session. A drop while COMMIT is in flight
 * is not retried, since the transaction may have committed.
 *
 * @param settings - URL and token.
 */
export const createRemoteRowDatabase =
  (settings: RemoteSettings): RowDatabase => {
    let shared = openRemote(settings)
    const reopen = () => {
      const lost = shared
      shared = openRemote(settings)
      lost.close().catch(() => undefined)
    }
    const onShared = <T>(work: (db: RowDatabase) => Promise<T>) => retried(() => work(rowsOver(shared)), reopen)
    return (
      { all: (sql, params) => onShared(db => db.all(sql, params))
      , get: (sql, params) => onShared(db => db.get(sql, params))
      , run: (sql, params) => onShared(db => db.run(sql, params))
      , transaction: async <T>(fn: (db: RowDatabase) => Promise<T>): Promise<T> => {
          let committing = false
          return retried(
            async () => {
              if (committing) throw new Error('The connection dropped while committing; the write may or may not have been saved')
              // A session of its own: nothing else interleaves, and foreign keys are on before BEGIN.
              const session = openRemote(settings)
              try {
                await session.exec(FOREIGN_KEYS)
                await session.exec('BEGIN')
                try {
                  const result = await fn({ ...rowsOver(session), run: async (sql, params = []) => await session.run(sql, ...params) as RunResult })
                  committing = true
                  await session.exec('COMMIT')
                  return result
                } catch (error) {
                  if (!committing) await session.exec('ROLLBACK').catch(() => undefined)
                  throw error
                }
              } finally {
                await session.close().catch(() => undefined)
              }
            }
            , () => {})
        }
      })
  }
