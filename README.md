# SRS

Secure Resource Server — turn JSON Schema files into a secure backend.
Describe your data, and it generates the database, API, migrations,
authentication, and authorization.


No CRUD handlers. No hand-written SQL.

## What it does

You write a schema:

```json
{
  "title": "Article",
  "type": "object",
  "properties": {
    "heading": { "type": "string" },
    "body": { "type": "string" }
  },
  "x-access": { "read": "public" }
}
```

SRS gives you:

- **Tables and relations** in Turso / SQLite, generated from the schema.
- **Migrations** that are deterministic and only change when the schema changes.
- **A JSON:API** with filtering, sorting, pagination, sparse fieldsets, and includes.
- **Authentication** with built-in OPAQUE accounts (passwords never reach the server), or bearer tokens from any OpenID Connect provider such as Keycloak, Authentik, Zitadel, Auth0 or Entra ID.
- **Authorization** with row ownership, private/public visibility, sharing, roles, and audit logs.
- **A TypeScript client** that works in browsers, Bun, and Node.

Every resource gets sensible defaults: private by default, owned by its creator,
and readable only according to its access rules.

## What you can use it for

SRS is a good fit when you need a backend quickly and mostly need standard
resource CRUD:

- prototypes, internal tools, and admin panels;
- content sites and catalogs;
- small SaaS apps where users own their data;
- frontends and mobile apps that need a ready-made JSON:API;
- projects that would otherwise rewrite the same auth, permissions, and CRUD code.

It is not an ORM, a general SQL layer, or a replacement for custom business
logic. Use it for the data and access layer, then add your own code for anything
unusual.

## Quick start

```bash
bun add github:consoleillusion/srs

# 1. Generate migrations from your schema folder.
bun srs init schemas

# 2. Add the printed OPAQUE_SERVER_SETUP line to .env
#    (or set SRS_OIDC_ISSUER and SRS_OIDC_AUDIENCE to use an identity provider).
# 3. Apply migrations and start the server.
bun srs serve
```

`srs init` writes generated migrations and a schema fingerprint to `.srs/`.
Commit that directory. Run `init` again after any schema change or package upgrade.

After that, every exposed table is available under its snake_case name:

```text
GET    /article        list articles
POST   /article        create an article
GET    /article/:id    read one article
PATCH  /article/:id    update an article
DELETE /article/:id    delete an article
```

## Learn more

- [Design book](design/README.md) — goals, rules, the security protocol, and the decision log (Typst; build with `bun run design`).
- [Documentation](doc/README.md) — schema reference, API, auth, access control, client, and operations.
- [Deployment](doc/deployment.md) — settings, reverse proxy, health checks, backups, and the container image.
- [Development](doc/development.md) — setup, commands, migrations, and tests.

Generated TypeScript API reference is written to `doc/` by `bun run docs`.

## Status

The core is complete: schema generation, relations, views, migrations,
JSON:API, OPAQUE and OpenID Connect authentication, and owner-based
authorization with sharing, roles, and signing. It runs as a single process per
database, with request limits, health checks, request logging, scheduled
verified backups and a restore command. Key rotation and revocation, metrics
and an external security review are still open; see the
[roadmap](doc/roadmap.md).
