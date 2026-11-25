# SRS

Standard Resource Server — turn JSON Schema files into a secure backend.
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

- **Tables and relations** in an embedded SQLite database, with no other service to run.
- **Migrations** that are deterministic and only change when the schema changes.
- **A JSON:API** with filtering, sorting, pagination, sparse fieldsets, and includes.
- **Security without TLS**: every request is encrypted to a server key the client pins (Noise), and signed after login.
- **Accounts** with OPAQUE, so passwords never reach the server, and every write is signed by the user's own key and kept.
- **Authorization** with row ownership, private/public visibility, sharing, roles, and an append-only audit log.
- **A TypeScript client** that works in browsers, Bun, and Node, and a browser console for trying the API.

Every resource gets sensible defaults: private by default, owned by its creator,
and readable only according to its access rules.

## What you can use it for

- **Scaffolding**: from schema files alone, a complete, standard, secure API for a web or mobile app, from prototype to production.
- **Internal tools and home labs** on networks where setting up TLS is impractical.
- **Accountable records**: approvals, inspections, timesheets, logs — each change signed by the person who made it.
- **Devices and AI agents**, each with its own account and every action attributable.
- **Published datasets** that anyone can read and only editors change.
- **An API over an existing SQLite database**: `bun src/cli.ts import shop.db` writes its schemas, keeping its keys, and `--data` copies its rows.

The design book's first chapter, _Why SRS_, covers these and what SRS is not for.

## Quick start

From a checkout of this repository:

```bash
bun install
bun run try
```

That starts a throwaway server on the sample schemas in `src/schema`, and a
browser console beside it, and prints a link with everything filled in. Press
Connect, register, and use the API. `bun run try --host 0.0.0.0` lets you open
the console from another machine.

To run a server yourself (in this repository the CLI is `bun src/cli.ts`; in a
project that depends on SRS it is `bunx srs`):

```bash
# 1. Generate migrations and keys from a schema folder.
bun src/cli.ts init src/schema

# 2. Put the printed OPAQUE_SERVER_SETUP and SRS_SERVER_KEYS lines in .env,
#    plus SRS_CORS_ORIGINS=http://127.0.0.1:5735 for the console.
#    Clients pin the printed fingerprint (srs1:…).

# 3. Start the server on port 5734.
bun src/cli.ts serve

# 4. In another terminal, serve the console on http://127.0.0.1:5735.
bun src/cli.ts console
```

`init` writes generated migrations and a schema fingerprint to `.srs/`.
Commit that directory. Run `init` again after any schema change or package upgrade.

Every exposed table is available under its snake_case name, through the
encrypted channel at `POST /noise`:

```text
GET    /article        list articles
POST   /article        create an article
GET    /article/:id    read one article
PATCH  /article/:id    update an article
DELETE /article/:id    delete an article
```

```ts
import { createSecureClient } from 'srs/client'
const client = createSecureClient({ baseUrl: 'http://10.0.0.5:5734', serverKey: 'srs1:…' })
await client.login({ username: 'paul', password: '…' })
const articles = await client.get('/article')
```

## Learn more

- [Design book](design/README.md) — the source of truth: goals, stack,
  architecture, the security protocol, the roadmap, and the reference for the
  schema, API, deployment and development. Build it with `bun run design`.
- API reference — generated from the code's TSDoc comments into `doc/` by
  `bun run docs`.
- [AGENTS.md](AGENTS.md) — where contributors and agents start.

## Status

Built in TypeScript: schema generation, relations, views, migrations, the
JSON:API, the Noise transport with OPAQUE accounts and signed requests, the
account lifecycle, key rotation, access control, operations (limits, health,
logging, metrics, backups), the browser console and a protocol conformance
suite. Next: importing existing databases, the remaining conformance suites
and a wire-format freeze, then a piece-by-piece move to a single Rust binary
with pluggable databases. The [design book](design/README.md) has the roadmap.
