import { buildSchema } from '../db/build-schema.ts'
import { applyMigrations } from '../db/migrate.ts'
import type { LoadedSchema } from '../db/schema-types.ts'
import type { Database } from '../db/open.ts'
import { createOidcVerifier } from '../auth/oidc.ts'
import { createApp } from './app/index.ts'
import { httpOptionsFromEnv } from './http.ts'
import { createRowDatabase } from './database.ts'

/** Split a comma-separated setting into trimmed, non-empty entries. */
const list =
  (value: string | undefined) => {
    return (value ?? '').split(',').map(x => x.trim()).filter(Boolean)
  }

/** Migrate the database, then build the HTTP app from the environment settings. */
export const createServerApp =
  async (options: { loaded: LoadedSchema[], db: Database, migrationsFolder: string }) => {
    const opaqueServerSetup = process.env.OPAQUE_SERVER_SETUP
    const issuer = process.env.SRS_OIDC_ISSUER
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
      , http: httpOptionsFromEnv()
      , admins: list(process.env.SRS_ADMINS)
      })
  }
