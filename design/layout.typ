== Repository layout <layout>

Status: *Implemented*, except the folders marked _planned_.

```text
src/
  auth/            OPAQUE service, /key routes, signing, limits, OIDC, keys
    service/         registration, login and key handlers
  client/          browser-safe TypeScript client
  console/         `srs console`: the browser page and its server
  db/              schema loading, derivation, building, views, migrations,
                   backup and restore
    build/           columns, relations, DDL, plans, views
    derive/          join tables and inverse relations
  helper/          database connection
  schema/          sample user schemas
    system/          system schemas, always loaded
  seed/            sample JSON:API documents for tests
  server/          Hono app, transport layer, registry, queries, mutations
    app/             routes, guard, CRUD and relationship handlers
    mutations/       write-document parsing and row writes
  cli.ts           `srs` command: init, serve, console, backup, restore and more
  commands.ts      the commands behind the CLI
  index.ts         public library exports
spec/              end-to-end tests through the app
  helpers/         test server, sign-in and client helpers
  unit/            unit tests by module
design/            this book: one .typ file per chapter, book.typ, build.sh
templates/         example schema folders for common patterns
doc/               generated API reference (bun run docs); not committed
conformance/       language-neutral conformance suites
  protocol/          protocol cases by topic
crates/            planned: Rust crates (v1.1)
.github/workflows/ CI
Containerfile      container image (Podman or Docker)
.env.example       every setting, with defaults
AGENTS.md          entry point for agents; CLAUDE.md is a copy
```

Generated and local files are not committed: `node_modules/`, `.migrations/`
(the library's own development migrations), databases, `.env`,
`design/book.pdf`, `doc/`. A project using SRS commits its `.srs/` folder, written by
`srs init`.

=== Design book files

#table(
  columns: (1fr, auto),
  table.header([*File*], [*Contents*]),
  [`book.typ`], [Title page, styles, parts and the order of chapters],
  [`build.sh`], [Compiles the book to `book.pdf`],
  [`introduction.typ`, `goals.typ`, `stack.typ`, `architecture.typ`], [Part I],
  [`schema.typ`, `migrations.typ`, `authored-views.typ`, `access-control.typ`, `http-api.typ`], [Part II],
  [`threat-model.typ`, `transport.typ`, `accounts.typ`, `requests.typ`, `lifecycle.typ`, `external-identity.typ`], [Part III],
  [`operations.typ`, `implementation.typ`, `roadmap.typ`], [Part IV],
  [`contributing.typ`, `layout.typ`, `decisions.typ`, `status.typ`], [Part V],
  [`ref-schema.typ`, `ref-data-model.typ`, `ref-api.typ`, `ref-auth.typ`, `ref-deployment.typ`, `ref-development.typ`], [Part VI],
)
