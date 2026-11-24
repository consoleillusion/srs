# Roadmap

Phases 0–6 are complete. Phase 8 is mostly complete. Phases 7 and 9–12 remain.

## Phase 0 — Foundation and deterministic builder

**Goal:** separate schema authoring from generation and remove the circular
dependency.

Deliverables:

- `load-schemas` module for filesystem discovery.
- Pure `build-schema` module producing tables, relations, join tables, views, and
  triggers.
- System schemas under `src/schema/system/`.
- Deterministic `.drizzleExports/index.ts`.
- Correct type mapping, `required`, defaults, `x-unique`, and JSON columns.
- Remove duplicated helpers and side effects from importable modules.

Exit criteria:

- importing the export module does not run the generator;
- builder unit tests cover all supported keywords;
- generated output is deterministic across runs.

## Phase 1 — Idempotent tables and baseline

**Goal:** create a clean, reproducible baseline and guarantee idempotent
generation.

Deliverables:

- reset the development `.drizzle` and `.db` baseline;
- generate `user`, `user_group`, `key`, `schema`, `article`, and `tag`;
- post-process new migrations with `IF NOT EXISTS` guards and triggers;
- custom-DDL state file;
- integration tests against a temporary database.

Exit criteria:

- generate twice → one migration;
- migrate twice → no errors;
- exactly one trigger per table;
- migration hashes match;
- baseline tables match the documented model.

## Phase 2 — Relations

**Goal:** generate foreign keys and join tables from `x-relations`.

Status: complete.

Deliverables:

- derived relation schemas for `one` FK columns and many-to-many join tables;
- `one` relations with nullable FK columns by default, `required` support, and
  `onDelete`/`onUpdate`;
- inverse-aware one-to-many detection;
- many-to-many join tables with default columns, `NOT NULL` FKs, unique pair,
  indexes, and trigger;
- unordered pair deduplication, explicit `through`, and conflict detection;
- table-level `x-unique-constraints`;
- topological table creation order with clear errors for cycles and
  self-references;
- system relations: `key.user`, `user.keys`, `user.groups`, `user_group.users`.

Exit criteria:

- one-to-many creates no join table;
- many-to-many creates exactly one join table;
- invalid targets, columns, and duplicate relations fail with clear errors;
- FK enforcement is tested.

## Phase 3 — Views

**Goal:** resolve foreign keys into actual data.

Status: complete.

Deliverables:

- one `<table>_view` per table with one row per table row;
- `one` relations as nested JSON objects or `null`;
- `many` relations as JSON arrays, including empty arrays;
- canonical lowercase UUID strings in views;
- custom-DDL integration for view creation and replacement;
- view hashes in `.drizzle/custom-ddl-state.json`.

Exit criteria:

- views are created in migrations;
- null FKs produce `null`, not partial objects;
- many relations return JSON arrays;
- re-running generation does not duplicate views;
- queries against views return canonical UUID strings.

Typed Drizzle view mappings and JSON:API `include` were delivered in Phase 4.

## Phase 4 — JSON:API

**Goal:** serve generated resources over Hono.

Status: complete.

Deliverables:

- Hono application and resource registry built from `BuiltSchema`;
- `ts-japi` serializers and relators created per request;
- resource catalog at `GET /`;
- collection and single-resource endpoints backed by `<table>_view`;
- pagination, sorting, filtering, sparse fieldsets, and direct `include`;
- write endpoints for create, replace, update, and delete;
- `HEAD` and `OPTIONS` support with advertised methods;
- JSON:API error responses and write validation;
- canonical string UUIDs in documents and lookups;
- seed documents for user-defined schemas;
- contract tests with an in-memory row database and end-to-end specs against
  migrated in-memory databases.

Exit criteria:

- `GET /article` and `GET /article/:id` return valid JSON:API documents;
- `POST`, `PUT`, `PATCH`, and `DELETE` mutate generated tables and join tables
  correctly;
- `include` resolves direct relationships from embedded view JSON;
- invalid requests return JSON:API errors with parameter sources;
- content type is `application/vnd.api+json`;
- server code consumes the same generated schema as migrations.

Nested include paths, relationship links, and typed Drizzle view mappings remain
future work.

## Phase 5 — Authentication

**Goal:** add OPAQUE registration/login and session keypairs.

Status: complete.

Deliverables:

- `/key` routes for registration, login, status, and deletion;
- server-side OPAQUE setup from the environment;
- stateless auth state persisted in the hidden `key` table;
- user records created from pending registration state;
- OPAQUE registration records, login state, and raw session keys stored in key
  rows;
- tweetnacl Ed25519 keypairs generated for every flow;
- JWK storage for server private keys and client public keys;
- 24-hour sessions with automatic purge and a delete endpoint;
- a hidden `key` resource and hidden `user.keys` relation through `x-exposed`;
- auth, exposure, and owner integration tests.

Exit criteria met:

- no plaintext password crosses the network;
- registration and login tests pass, including duplicate, expiry, unknown-user,
  and replay cases;
- session keypairs are fresh on every login and stored until expiry;
- expired and deleted sessions fail closed;
- key status never exposes key material.

## Phase 6 — Authorization and sharing

**Goal:** enforce access control and group-based sharing.

Status: mostly complete.

Done:

- owner-based authorization;
- per-row visibility;
- read/write shares to users and groups;
- anonymous creates;
- opt-in signed requests with replay protection;
- inherited read access;
- roles with a configurable admin;
- audit trails.

Remaining:

- key rotation and revocation;
- moderation of inherited rows by the parent's owner.

Exit criteria:

- an access matrix test suite passes;
- group sharing works only through explicitly authorized keys;
- unauthorized access is denied consistently;
- key history remains attributable.

## Phase 7 — AI schema workflow

**Goal:** make schema authoring cheap and reliable for AI models.

Deliverables:

- AJV validation with actionable error messages;
- JSON Schema to TypeScript type generation;
- schema catalog endpoint;
- schema versioning and migration guidance;
- examples and templates for common resource patterns.

Exit criteria:

- a model can add a resource by writing one schema file;
- invalid schemas fail before touching the database;
- generated errors identify the exact schema path;
- a new resource is queryable through the API without handwritten backend code.

## Phase 8 — Operations and hardening

**Goal:** make the system safe to operate.

Status: mostly complete.

Done:

- scheduled, verified backups; a verified restore command;
- CI that type-checks, audits dependencies, checks the API reference, checks that
  generation is deterministic and idempotent, and runs the tests;
- structured request logging and request ids;
- general request rate limiting, proxy-aware client addresses and a request body
  limit;
- a CORS policy (none unless origins are listed) and security headers;
- health and readiness routes;
- deployment documentation and a container image;
- graceful shutdown;
- external identity provider support.

Remaining:

- metrics;
- a third-party security review.

Exit criteria:

- a fresh deployment can be bootstrapped from migrations;
- a backup can be restored and verified;
- CI rejects non-idempotent or non-deterministic generation;
- security checklist is complete.

## Phase 9 — Secure transport and accountable accounts

**Goal:** be secure on networks without TLS, with every request encrypted and
signed.

Status: specified in the design book (sections Threat model, Transport,
Accounts and login, Signed requests, Account lifecycle); not built.

Deliverables:

- a Noise NK channel authenticated by a pinned server key, with strict mode;
- per-user identity keys wrapped under the OPAQUE export key;
- login bound to the channel, session certificates, and resume;
- every request signed and encrypted; signature retention;
- logout, device list, password change, revocation, admin reset, and server key
  rotation;
- `key.user` changed to `onDelete: restrict`.

Exit criteria:

- the handshake passes the published Noise test vectors;
- every attack case listed in the design book has a test;
- the handshake, binding, and certificate steps are modelled and proved in a
  protocol analysis tool;
- an external protocol review is complete.

## Phase 10 — Stable TypeScript and conformance suites

**Goal:** a stable TypeScript implementation that serves as the reference.

Status: specified in the design book (section Implementation plan); not built.

Deliverables:

- language-neutral conformance suites for the protocol, schema engine, query
  compiler, access decisions, and HTTP behaviour;
- the end-to-end tests rewritten to drive the server over HTTP only;
- the wire format frozen and versioned.

Exit criteria:

- Phase 9 complete, including the external review;
- the TypeScript implementation passes every conformance suite;
- at least one real deployment has run without a protocol change.

## Phase 11 — Rust, piece by piece

**Goal:** replace the server with Rust one module at a time, ending in a single
static binary.

Status: specified in the design book; not built.

Order: protocol core, schema engine, query compiler, access decisions,
storage, then HTTP and accounts. Each piece runs inside the Bun process through
Node-API behind an `SRS_IMPL_<PIECE>` switch, and becomes the default only after
passing its conformance suite and differential tests.

## Phase 12 — Pluggable databases

**Goal:** PostgreSQL and MySQL alongside SQLite, once Rust owns storage.

Status: specified in the design book; not built.

## Current status

The generator is split into schema loading, relation derivation, deterministic
building, view generation, export generation, migration post-processing,
custom-DDL state, and reset modules. System schemas for `user`, `user_group`,
`key`, `schema`, `user_role`, `audit_log`, `request_nonce`, and `auth_limit` are
loaded alongside user schemas.

Generation and migration application are both idempotent. The baseline has one
`updated_at` trigger and one view per table. The Hono application serves generated
views as JSON:API collections and single resources, writes to generated tables
and join tables, and supports `HEAD` and `OPTIONS`. OPAQUE registration and login
run through `/key`, and all temporary auth state lives in the hidden `key` table.

Authorization is owner-based, with per-row visibility, sharing, roles, inherited
read access, audit trails, and opt-in request signing. A browser-safe client at
`resource-server/client` wraps registration, login, session storage, and JSON:API
requests. Invalid requests return JSON:API errors; API and auth tests run against
in-memory Turso databases created from all migrations.

Remaining Phase 6 work is key rotation and revocation, and moderation of
inherited rows by the parent's owner.
