/**
 * SRS as a request handler for serverless platforms such as Vercel, where
 * there is no long-running process and no local database file (design book,
 * Deployment). It reads and writes the remote Turso database named by
 * `SRS_DATABASE_URL`, and serves the bearer transport over the platform's
 * HTTPS: a Noise channel lives in one process's memory, which a serverless
 * platform does not keep between requests.
 *
 * ```ts
 * // src/pages/api/[...path].ts in an Astro site
 * import schemas from '../../../.srs/schemas.json'
 * import { createHandler } from 'srs/serverless'
 * const handle = await createHandler({ schemas, basePath: '/api' })
 * export const ALL = ({ request }) => handle(request)
 * ```
 *
 * Apply migrations before each deploy with the migrate command.
 *
 * @module
 */
import type { LoadedSchema } from './db/schema-types.ts'
import { createRemoteRowDatabase, remoteSettings } from './db/remote.ts'
import { createServerApp } from './server/start.ts'

/**
 * Build the handler.
 *
 * @param options - The schemas `init` wrote to `.srs/schemas.json`, and the path the API is mounted under.
 * @returns A function from a `Request` to a `Response`.
 * @throws When SRS_DATABASE_URL is not set, or SRS_TRANSPORT asks for Noise.
 */
export const createHandler =
  async (options: { schemas: unknown, basePath?: string }) => {
    const remote = remoteSettings()
    if (!remote)
      throw new Error('A serverless handler needs a remote database: set SRS_DATABASE_URL and SRS_DATABASE_TOKEN.')
    if (process.env.SRS_TRANSPORT === 'noise')
      throw new Error('The Noise transport keeps channels in one process, so it cannot run serverless; use the bearer transport over HTTPS.')
    const app =
      await createServerApp(
        { loaded: options.schemas as LoadedSchema[], rows: createRemoteRowDatabase(remote), transport: 'bearer' })
    const base = (options.basePath ?? '').replace(/\/+$/, '')
    return (request: Request): Promise<Response> | Response => {
      if (!base) return app.fetch(request)
      const url = new URL(request.url)
      if (url.pathname !== base && !url.pathname.startsWith(`${base}/`))
        return new Response('Not Found', { status: 404 })
      url.pathname = url.pathname.slice(base.length) || '/'
      return app.fetch(new Request(url.toString(), request))
    }
  }
