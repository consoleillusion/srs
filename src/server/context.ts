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
  /** SHA-256 of the signed message, kept for the audit log. */
  , signedDigest?: Uint8Array
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
  , oidcSubject?: string
  }

/** The Hono environment used by the resource server. */
export type Env = { Variables: Variables }

/** A request context carrying the typed {@link Variables}. */
export type AppContext = Context<Env>

export type { Next }

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
