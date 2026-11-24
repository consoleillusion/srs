/**
 * The `console` command: serve a browser page for using a server over the Noise
 * transport: connect, register, log in, and explore the API (design book,
 * Console). The page is bundled from `app.ts` when the command starts.
 *
 * @module
 */
import { join } from 'node:path'

/** Default port of the console page. */
export const CONSOLE_PORT = 5735

/**
 * Bundle the console's browser script.
 *
 * @returns The JavaScript for `/app.js`.
 * @throws When the bundle fails to build.
 */
export const buildConsole =
  async (): Promise<string> => {
    const result =
      await Bun.build(
        { entrypoints: [join(import.meta.dir, 'app.ts')], target: 'browser', minify: true, format: 'esm' })
    if (!result.success)
      throw new Error(`The console bundle failed to build:\n${result.logs.map(String).join('\n')}`)
    return await result.outputs[0]!.text()
  }

/**
 * Serve the console page.
 *
 * @param options - Port and host to listen on; `127.0.0.1` by default, so only this machine can open it.
 * @returns The running server.
 */
export const serveConsole =
  async (options: { port?: number, host?: string } = {}) => {
    const script = await buildConsole()
    const page = await Bun.file(join(import.meta.dir, 'index.html')).text()
    const headers = (type: string) => ({ 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    return Bun.serve(
      { port: options.port ?? CONSOLE_PORT
      , hostname: options.host ?? '127.0.0.1'
      , fetch: request => {
          const path = new URL(request.url).pathname
          if (path === '/' || path === '/index.html') return new Response(page, { headers: headers('text/html; charset=utf-8') })
          if (path === '/app.js') return new Response(script, { headers: headers('text/javascript; charset=utf-8') })
          return new Response('Not Found', { status: 404 })
        }
      })
  }
