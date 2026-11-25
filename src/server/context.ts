import type { Context, Next } from 'hono'
import type { Channel } from './channels.ts'

/**
 * Key under which a request decrypted from a Noise envelope carries its
 * channel. Requests from the network cannot set it, because it is a private
 * symbol on the handler's environment, not a header.
 */
export const INNER = Symbol('srs.inner')

/** What a request decrypted from a Noise envelope knows about itself. */
export type InnerRequest =
  { channel: Channel
  /** The client address of the outer request, for rate limits. */
  , client: string
  /** Whether the request carried a signature that verified. */
  , signed: boolean
  /** The signature, kept for the audit log. */
  , signature?: Uint8Array
  /** The exact signed bytes, kept for the audit log. */
  , signedMessage?: Uint8Array
  /** The request body, kept for the audit log. */
  , body?: Uint8Array
  }

/**
 * The decrypted-request marker of a request, if it came through a channel.
 *
 * @param c - The request context.
 */
export const innerOf =
  (c: Context): InnerRequest | undefined =>
    (c.env as Record<symbol, InnerRequest> | undefined)?.[INNER]

/** Values the middleware stores on the request context for later handlers. */
export type Variables =
  { anonymous?: boolean
  , userId?: string
  , sessionId?: string
  , sessionKey?: Uint8Array
  , clientJwk?: unknown
  , signed?: boolean
  , roles?: string[]
  /** The path the API is mounted under, such as `/api`; empty at the root. */
  , base?: string
  }

/** The Hono environment used by the resource server. */
export type Env = { Variables: Variables }

/** A request context carrying the typed {@link Variables}. */
export type AppContext = Context<Env>

export type { Next }

/**
 * The URL a client used for this request: the request URL with the mount
 * path the platform stripped put back, so links and signatures match what
 * the client sees.
 *
 * @param c - The request context.
 * @returns A fresh URL the caller may change.
 */
export const publicUrl =
  (c: AppContext): URL => {
    const url = new URL(c.req.url)
    const base = c.get('base') ?? ''
    if (base) url.pathname = url.pathname === '/' ? base : `${base}${url.pathname}`
    return url
  }

/**
 * The origin and mount path that resource links start with.
 *
 * @param c - The request context.
 * @returns For example `https://techstudy.app/api`.
 */
export const linkRoot =
  (c: AppContext): string => `${new URL(c.req.url).origin}${c.get('base') ?? ''}`

/**
 * Read a path parameter that the route pattern guarantees.
 *
 * @param c - The request context.
 * @param name - The parameter name, such as `type` or `id`.
 * @returns The parameter value, or an empty string when absent.
 */
export const pathParam =
  (c: AppContext, name: string): string => {
    return c.req.param(name) ?? ''
  }
