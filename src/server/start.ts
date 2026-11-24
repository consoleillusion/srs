import { buildSchema } from '../db/build-schema.ts'
import { applyMigrations } from '../db/migrate.ts'
import type { LoadedSchema } from '../db/schema-types.ts'
import type { Database } from '../db/open.ts'
import { createOidcVerifier } from '../auth/oidc.ts'
import { parseServerKeys, parseTransition } from '../auth/server-keys.ts'
import { checkTransition } from '../protocol/server-keys.ts'
import { createApp } from './app/index.ts'
import { httpOptionsFromEnv } from './http.ts'
import type { Metrics } from './metrics.ts'
import { createRowDatabase } from './database.ts'

/** Split a comma-separated setting into trimmed, non-empty entries. */
const list =
  (value: string | undefined) => {
    return (value ?? '').split(',').map(x => x.trim()).filter(Boolean)
  }

/** Migrate the database, then build the HTTP app from the environment settings. */
export const createServerApp =
  async (options: { loaded: LoadedSchema[], db: Database, migrationsFolder: string, metrics?: Metrics }) => {
    const opaqueServerSetup = process.env.OPAQUE_SERVER_SETUP
    const issuer = process.env.SRS_OIDC_ISSUER
    const transport = process.env.SRS_TRANSPORT ?? 'noise'
    if (transport !== 'noise' && transport !== 'bearer')
      throw new Error(`SRS_TRANSPORT must be "noise" or "bearer", got "${transport}"`)
    if (transport === 'noise') {
      if (!process.env.SRS_SERVER_KEYS)
        throw new Error(
          'SRS_SERVER_KEYS is required for the Noise transport; run `srs init` to create it, '
          + 'or set SRS_TRANSPORT=bearer to serve over TLS instead.')
      if (!opaqueServerSetup)
        throw new Error('OPAQUE_SERVER_SETUP is required; run `srs init` to create it.')
      if (issuer)
        throw new Error('SRS_OIDC_ISSUER needs SRS_TRANSPORT=bearer: identity-provider tokens cannot be used in the Noise transport.')
    }
    if (!opaqueServerSetup && !issuer)
      throw new Error(
        'Set OPAQUE_SERVER_SETUP (run `srs init` to create one) for built-in '
        + 'accounts, SRS_OIDC_ISSUER to sign users in through an identity provider, or both.')

    const oidc =
      issuer
        ? await createOidcVerifier(
            { issuer
            , audience: process.env.SRS_OIDC_AUDIENCE ?? ''
            , jwksUri: process.env.SRS_OIDC_JWKS_URI || undefined
            })
        : undefined

    const serverKeys = process.env.SRS_SERVER_KEYS ? parseServerKeys(process.env.SRS_SERVER_KEYS) : undefined
    const previousSetting = process.env.SRS_PREVIOUS_SERVER_KEYS
    const transitionSetting = process.env.SRS_KEY_TRANSITION
    if ((previousSetting === undefined) !== (transitionSetting === undefined))
      throw new Error('SRS_PREVIOUS_SERVER_KEYS and SRS_KEY_TRANSITION are set together, by `srs rotate-keys`')
    let rotation: { previous: ReturnType<typeof parseServerKeys>, transition: ReturnType<typeof parseTransition> } | undefined
    if (serverKeys && previousSetting && transitionSetting) {
      rotation = { previous: parseServerKeys(previousSetting), transition: parseTransition(transitionSetting) }
      // Refuse to serve a statement that clients would reject.
      checkTransition(rotation.previous, serverKeys, rotation.transition.stopAt, rotation.transition.signature)
    }

    // Bring the database up to date before serving; a failure stops the server.
    if (process.env.MIGRATE_ON_START !== 'false')
      await applyMigrations(options.db, options.migrationsFolder)

    return createApp(
      { built: buildSchema(options.loaded)
      , db: createRowDatabase(options.db)
      , opaqueServerSetup
      , requireSession: true
      , oidc
      , oidcAdmins: list(process.env.SRS_OIDC_ADMIN_SUBJECTS)
      , http: { ...httpOptionsFromEnv(), metrics: options.metrics }
      , serverKeys
      , rotation
      , transport
      , retainReads: process.env.SRS_RETAIN_READS === 'true'
      , allowReset: process.env.SRS_ALLOW_RESET !== 'false'
      , admins: list(process.env.SRS_ADMINS)
      })
  }
