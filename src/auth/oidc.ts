import { createHash } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import type { RowDatabase } from '../server/database.ts'
import { unauthorized } from '../server/errors.ts'
import { newUuid, uuidToBuffer } from '../server/uuid.ts'

/** The claims SRS reads from a verified token. */
export type OidcClaims =
  { sub: string
  , name?: string
  , preferred_username?: string
  , email?: string
  , email_verified?: boolean
  }

/** Checks one bearer token and returns its claims, or throws a 401. */
export type TokenVerifier = (token: string) => Promise<OidcClaims>

/** Verifies bearer tokens issued by one external OpenID Connect provider. */
export type OidcVerifier =
  { issuer: string
  /** Check signature, issuer, audience and expiry; throws a 401 for anything else. */
  , verify: TokenVerifier
  }

/** Settings for {@link createOidcVerifier}. */
export type OidcOptions =
  { /** The provider's issuer URL; must be https (or localhost for development). */
    issuer: string
  /** The audience the provider puts in tokens meant for this server. */
  , audience: string
  /** Where the provider publishes its signing keys; discovered from the issuer when omitted. */
  , jwksUri?: string
  /** A key resolver to use in place of fetching keys (for tests and custom setups). */
  , keys?: JWTVerifyGetKey
  }

// Asymmetric algorithms only: a shared-secret (HS*) or unsigned token is never accepted.
const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA']
const CLOCK_TOLERANCE_SECONDS = 30
const DISCOVERY_TIMEOUT_MS = 5_000

/** Fail unless the issuer is an https URL, or http on a loopback host. */
const checkIssuer =
  (issuer: string) => {
    // Purpose: refuse an issuer URL that would send keys or tokens over plain http
    let url: URL
    try {
      url = new URL(issuer)
    } catch {
      throw new Error(`SRS_OIDC_ISSUER is not a valid URL: "${issuer}"`)
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      throw new Error('SRS_OIDC_ISSUER must use https (http is allowed only for localhost)')
  }

/** Look up the provider's signing-key URL from its discovery document. */
const discoverJwksUri =
  async (issuer: string) => {
    // Purpose: read jwks_uri from the issuer's discovery document and confirm it names the same issuer
    const base = issuer.replace(/\/+$/, '')
    const response =
      await fetch(
        `${base}/.well-known/openid-configuration`
        , { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) })
    if (!response.ok)
      throw new Error(`OIDC discovery failed for ${issuer}: HTTP ${response.status}`)

    const document = await response.json() as { issuer?: string, jwks_uri?: string }
    if (document.issuer?.replace(/\/+$/, '') !== base)
      throw new Error(`OIDC discovery document for ${issuer} names a different issuer`)
    if (!document.jwks_uri)
      throw new Error(`OIDC discovery document for ${issuer} has no jwks_uri`)
    return document.jwks_uri
  }

/**
 * Build a verifier for tokens from one OpenID Connect provider.
 *
 * Fetches the provider's discovery document once, so a wrong issuer fails at
 * startup rather than on the first request. Keys are then cached and refreshed
 * by `jose` as the provider rotates them.
 *
 * @param options - The issuer, audience and optional key source.
 * @returns A verifier that accepts only well-formed, unexpired tokens for this audience.
 */
export const createOidcVerifier =
  async (options: OidcOptions): Promise<OidcVerifier> => {
    // Purpose: validate the settings and return a verifier bound to the provider's signing keys
    checkIssuer(options.issuer)
    if (!options.audience)
      throw new Error('SRS_OIDC_AUDIENCE is required when SRS_OIDC_ISSUER is set')

    const keys =
      options.keys
      ?? createRemoteJWKSet(
        new URL(options.jwksUri ?? await discoverJwksUri(options.issuer))
        , { timeoutDuration: DISCOVERY_TIMEOUT_MS, cooldownDuration: 30_000 })

    return (
      { issuer: options.issuer
      , verify: async token => {
          // Purpose: verify one bearer token and return its claims, hiding why a bad token failed
          try {
            const { payload } =
              await jwtVerify(
                token
                , keys
                , { issuer: options.issuer
                  , audience: options.audience
                  , algorithms: ALGORITHMS
                  , requiredClaims: ['sub', 'exp']
                  , clockTolerance: CLOCK_TOLERANCE_SECONDS
                  })
            if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 255)
              throw new Error('invalid subject')
            return payload as OidcClaims
          } catch {
            throw unauthorized('Invalid or expired token')
          }
        }
      })
  }

/** Cut a claim to a column's length, or drop it when it is not a non-empty string. */
const clip =
  (value: unknown, max: number) =>
    typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null

/**
 * Find the user for a verified identity, creating the user the first time it is seen.
 *
 * The username is derived from the issuer and subject, never from a claim a user
 * can choose, so an external identity cannot take over a username (and with it
 * any admin rights tied to one).
 *
 * @param db - The database.
 * @param issuer - The verified token's issuer.
 * @param claims - The verified claims.
 * @returns The user's id as a buffer.
 */
export const resolveOidcUser =
  async (db: RowDatabase, issuer: string, claims: OidcClaims): Promise<Uint8Array> => {
    // Purpose: return the local user for an external identity, provisioning it on first sight
    const find =
      async () => {
        // Purpose: look the user up by issuer and subject
        const row =
          await db.get(
            'SELECT `id` FROM `user` WHERE `oidc_issuer` = ? AND `oidc_subject` = ?'
            , [issuer, claims.sub])
        return row?.id instanceof Uint8Array ? row.id : undefined
      }

    const existing = await find()
    if (existing) return existing

    const id = uuidToBuffer(newUuid())
    const username =
      'oidc-' + createHash('sha256').update(`${issuer}\n${claims.sub}`).digest('hex').slice(0, 32)
    // An address the provider has not verified must not be shown as the user's own.
    const email = claims.email_verified === true ? clip(claims.email, 255) : null
    try {
      await db.run(
        'INSERT INTO `user` (`id`, `username`, `display_name`, `email`, `oidc_issuer`, `oidc_subject`, `owner`)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?)'
        , [ id
          , username
          , clip(claims.name ?? claims.preferred_username, 100)
          , email
          , issuer
          , claims.sub
          , id
          ])
      return id
    } catch (error) {
      // A concurrent first request may have created the user; use theirs.
      const created = await find()
      if (created) return created
      throw error
    }
  }
