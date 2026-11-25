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
 * @param settings - URL and token.
 */
export const createRemoteRowDatabase =
  (settings: RemoteSettings): RowDatabase => {
    const shared = openRemote(settings)
    return (
      { ...rowsOver(shared)
      , transaction: async <T>(fn: (db: RowDatabase) => Promise<T>): Promise<T> => {
          // A session of its own: nothing else interleaves, and foreign keys are on before BEGIN.
          const session = openRemote(settings)
          try {
            await session.exec(FOREIGN_KEYS)
            await session.exec('BEGIN')
            try {
              const result = await fn({ ...rowsOver(session), run: async (sql, params = []) => await session.run(sql, ...params) as RunResult })
              await session.exec('COMMIT')
              return result
            } catch (error) {
              await session.exec('ROLLBACK').catch(() => undefined)
              throw error
            }
          } finally {
            await session.close().catch(() => undefined)
          }
        }
      })
  }
