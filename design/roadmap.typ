== Roadmap <roadmap>

Status: *Implemented* — this is the live list of work.

=== How to use this roadmap

- Work is grouped into release series. Each series is a minor version
  (`v0.3`) and each task in it is a patch version (`v0.3.4`). Versions follow
  semantic versioning; `v1.0.0` is the stable TypeScript release with a frozen
  wire format.
- When a task is done, the `version` in `package.json` is set to the task's
  version and the commit is tagged with it (`git tag v0.3.4`). The current
  version is the last task done.
- Series are released in order, and tasks within a series in order. A task may
  start when the tasks it depends on are done; dependencies are noted where
  they are not simply the task before. Work on a later series may be developed
  alongside an earlier one, but is released after it.
- Each task has a _done when_ condition. A task is done only when that holds,
  the standard checks pass (@contributing), and this chapter is updated: the
  task's state set to *Done*, and the status lines of the chapters it touched
  updated.
- States are *Done*, *Next* (may start now), *Later* (blocked by earlier
  tasks) and *Open* (needs a design decision first; do not build).
- New work is added here before it starts, as a task with a version and a
  done-when condition. Inserting a task renumbers only the unreleased tasks
  after it.

#table(
  columns: (auto, 1fr, auto),
  table.header([*Series*], [*Goal*], [*State*]),
  [v0.1], [Core: schema to tables, views, migrations, JSON:API, OPAQUE accounts, access control], [Done],
  [v0.2], [Production hardening of the current server], [In progress (`v0.2.0` done)],
  [v0.3], [Secure transport and accountable accounts, in TypeScript], [Done],
  [v0.4], [Schema authoring workflow and existing databases], [In progress],
  [v0.5], [Conformance suites], [In progress],
  [v0.6], [Wire-format freeze and real use], [Later],
  [v1.0], [Stable TypeScript release], [Later],
  [v1.1], [Rust, piece by piece], [Later],
  [v1.2], [Pluggable databases], [Later],
  [v1.3], [JSON:API 1.1 and Dhall schemas], [Later],
  [v2.0], [Post-quantum cryptography], [Later],
)

=== v0.1 — Core

Done (`v0.1.0`). Schema loading and derivation, relations, join tables, generated and
authored views, deterministic migrations, the JSON:API with filtering, sorting,
pagination, sparse fieldsets and includes, OPAQUE registration and login,
owner-based access control with visibility, sharing, roles, inheritance and
audit, per-resource signed requests in the bearer transport, and the
TypeScript client.

=== v0.2 — Production hardening

Built in `v0.2.0`: request body limit, CORS, security headers, request rate limit,
proxy-aware client address, request logging with ids, health and readiness
routes, graceful shutdown, scheduled verified backups, the `backup` command and
the `restore` command, CI, container image, deployment reference.

#table(
  columns: (auto, 1fr, 1.3fr, auto),
  table.header([*Version*], [*Task*], [*Done when*], [*State*]),
  [v0.2.1], [Make `key.user` `onDelete: restrict`], [The system schema says `restrict`; a migration is generated; a test shows deleting a user who owns keys fails with `409`.], [Done],
  [v0.2.2], [Verify CI on GitHub], [The workflow passes on a push to the repository.], [Done],
  [v0.2.3], [Verify the container image], [`podman build` succeeds; a container with a mounted project serves `/readyz` as `200`, takes a backup, and stops cleanly on `SIGTERM`. Steps recorded in @ref-deployment.], [Next],
  [v0.2.4], [Built-in accounts only], [Sign-in is OPAQUE only; no external identity provider is needed or accepted (D053).], [Done],
  [v0.2.5], [Metrics], [With `SRS_METRICS_PORT` set, a second listener on `127.0.0.1` serves Prometheus text format: requests by route pattern and status, request duration histogram, login successes and failures, backup age. Off by default. Tests cover the output.], [Done],
  [v0.2.6], [Protect `audit_log` in the database], [Triggers make `UPDATE` and `DELETE` on `audit_log` fail; a test proves it.], [Done],
  [v0.2.7], [Ed25519 from `@noble/curves`], [`tweetnacl` is removed; signing and verification use `@noble/curves`; existing signing tests pass unchanged.], [Done],
  [v0.2.8], [One-way documentation], [The reference lives in the book (Part VI); client usage is TSDoc; `doc/` holds only TypeDoc output and is not committed; no hand-written Markdown reference remains.], [Done],
)

=== v0.3 — Secure transport and accounts (TypeScript)

Specified in @transport, @accounts, @requests and @lifecycle. Every task adds
its attack tests from the list in @status as it goes.

#table(
  columns: (auto, 1fr, 1.3fr, auto),
  table.header([*Version*], [*Task*], [*Done when*], [*State*]),
  [v0.3.0], [Encoding helpers], [Length-prefixed field encoding and the fixed certificate layout (@certificates), with fixtures in `conformance/protocol/encoding/`. Depends on v0.5.0, which defines the fixture format.], [Done],
  [v0.3.1], [Server key bundle], [the `init` command creates the bundle when `SRS_SERVER_KEYS` is unset and prints the `srs1:` fingerprint; `GET /noise/keys` serves the bundle; fingerprint fixtures exist.], [Done],
  [v0.3.2], [Noise NK handshake], [`POST /noise/handshake` works; the implementation passes the published `Noise_NK_25519_ChaChaPoly_BLAKE2s` test vectors; handshake rate limit in place.], [Done],
  [v0.3.3], [Envelope and replay window], [`POST /noise` decrypts into an ordinary request and encrypts the response; replay, reorder, truncation and cross-channel tests pass.], [Done],
  [v0.3.4], [Strict mode], [`SRS_TRANSPORT=noise` serves only the clear routes in @http-api; a downgrade test passes.], [Done],
  [v0.3.5], [Identity keys and registration], [Registration creates the wrapped identity key with proof of possession; a test shows a key without proof is refused.], [Done],
  [v0.3.6], [Bound login and certificates], [Login checks the binder, creates login records and accepts certificates per @certificates; relayed-login and swapped-key tests pass.], [Done],
  [v0.3.7], [Resume], [A client resumes after a server restart without the password; a certificate for an ended login is refused.], [Done],
  [v0.3.8], [Signing and retention], [Every request after login is verified; audit rows retain signatures and bodies per @retention; an offline verifier script checks a retained signature from the database alone.], [Done],
  [v0.3.9], [Client transport], [`createSecureClient({ baseUrl, serverKey })` speaks the Noise transport end to end against a real the `serve` command process over HTTP.], [Done],
  [v0.3.10], [Logout, devices, password change], [The routes in @lifecycle work, with tests.], [Done],
  [v0.3.11], [Revocation, admin reset, disabling users], [As specified in @lifecycle, including `SRS_ALLOW_RESET`, with tests.], [Done],
  [v0.3.12], [Server key rotation], [the `rotate-keys` command and transition statements work; a forged statement is refused.], [Done],
  [v0.3.13], [Browser check], [The secure client works in a real browser on a plain-HTTP page loaded from a trusted origin, with no `crypto.subtle`: `spec/browser.test.ts` drives the console in headless Chrome on a LAN address (@ref-console).], [Done],
  [v0.3.14], [Browser console], [The `console` command serves a page that connects to a pinned server, registers, logs in, and lists, creates, updates and deletes resources over the Noise transport (@ref-console).], [Done],
  [v0.3.15], [Try it], [`bun run try` starts a throwaway server and the console, configured for each other, and prints a link with the server URL and fingerprint filled in; the browser test runs it.], [Done],
)

=== v0.4 — Schema authoring workflow

Makes adding a resource reliable for people and AI models. Independent of v0.3.

#table(
  columns: (auto, 1fr, 1.3fr, auto),
  table.header([*Version*], [*Task*], [*Done when*], [*State*]),
  [v0.4.0], [Schema validation], [Schema files are validated against a meta-schema of the supported keywords before any SQL is generated; every error names the file and the JSON pointer of the fault.], [Done],
  [v0.4.1], [Type generation], [the `init` command writes TypeScript types for every exposed resource, used by the client.], [Done],
  [v0.4.2], [Schema catalog], [The resource catalog at `GET /` describes each resource's attributes and relations.], [Done],
  [v0.4.3], [Templates], [Example schemas for common patterns (owned notes, shared documents, public catalog, chat with inherited messages) with tests that load them.], [Done],
  [v0.4.4], [Schema change guidance], [The schema reference explains which changes rebuild tables and which lose data.], [Done],
  [v0.4.5], [Import schemas from SQLite], [`bun src/cli.ts import <file.db> --out schemas` writes one schema per table following the mapping in @existing-databases, with a report of what it could not map; the written schemas pass the meta-schema and the `init` command.], [Next],
  [v0.4.6], [Import rows], [`import --data` copies rows into the SRS database in one transaction: new ids, `source_id` kept, foreign keys rewritten, rows owned by `--owner`. The source is opened read-only.], [Later],
)

=== v0.5 — Conformance suites

Defined in @implementation. Protocol fixtures are written during v0.3.

#table(
  columns: (auto, 1fr, 1.3fr, auto),
  table.header([*Version*], [*Task*], [*Done when*], [*State*]),
  [v0.5.0], [Suite format and runner], [The book defines the case format (@implementation); a TypeScript runner runs every suite with the tests.], [Done],
  [v0.5.1], [Protocol suite], [Complete for every message in Part III, including invalid inputs.], [Done],
  [v0.5.2], [Schema engine suite], [Schema folders with expected built schema, SQL and migration state.], [Next],
  [v0.5.3], [Query compiler and access suites], [Expected SQL, parameters and access decisions.], [Next],
  [v0.5.4], [HTTP suite], [The end-to-end tests drive the server over HTTP only, against a server started as a process.], [Next],
)

=== v0.6 — Freeze

#table(
  columns: (auto, 1fr, 1.3fr, auto),
  table.header([*Version*], [*Task*], [*Done when*], [*State*]),
  [v0.6.0], [Freeze the wire format], [Every protocol string carries `v1`; the protocol fixtures are complete; the freeze is a decision row.], [Later],
  [v0.6.1], [Real use], [At least one real deployment runs without a protocol change; findings are fixed.], [Later],
)

=== v1.0 — Stable TypeScript release

`v1.0.0` is released when v0.2 to v0.6 are done. From then on the wire format
is frozen (@implementation), and a breaking change to the HTTP API or the
protocol needs a new major version.

=== v1.1 — Rust, piece by piece

Order and switching rules in @implementation. Starts after v1.0.0.

#table(
  columns: (auto, 1fr, 1.3fr, auto),
  table.header([*Version*], [*Task*], [*Done when*], [*State*]),
  [v1.1.0], [Native-module proof of concept], [A `napi-rs` module loads in Bun on Linux, macOS and Windows and is built in CI. If Bun's Node-API support is insufficient, this is recorded and the plan is revisited before v1.1.1.], [Later],
  [v1.1.1], [`srs-protocol`], [Passes the protocol suite natively and as WebAssembly; `SRS_IMPL_PROTOCOL=rust` passes all tests.], [Later],
  [v1.1.2], [`srs-schema`], [Passes the schema engine suite; `SRS_IMPL_SCHEMA=rust`.], [Later],
  [v1.1.3], [`srs-query`], [Passes the query suite; `SRS_IMPL_QUERY=rust`.], [Later],
  [v1.1.4], [Access decisions], [Passes the access suite; `SRS_IMPL_ACCESS=rust`.], [Later],
  [v1.1.5], [`srs-store`], [Rust owns the database; all suites pass.], [Later],
  [v1.1.6], [`srs-server`], [The Rust binary passes the HTTP suite with no Bun process; released as a static binary.], [Later],
)

=== v1.2 — Pluggable databases

#table(
  columns: (auto, 1fr, 1.3fr, auto),
  table.header([*Version*], [*Task*], [*Done when*], [*State*]),
  [v1.2.0], [Database settings], [`SRS_DATABASE_URL` and `SRS_DATABASE_TOKEN` select the database (@implementation); with neither set, the embedded SQLite file is used. Built after the Rust migration (v1.1), hosted SQLite included.], [Later],
  [v1.2.1], [Choose the SQL layer], [A decision row selects `sqlx`, `sea-query` or both.], [Later],
  [v1.2.2], [PostgreSQL], [Every suite passes against PostgreSQL.], [Later],
  [v1.2.3], [MySQL], [Every suite passes against MySQL.], [Later],
  [v1.2.4], [Several processes], [Open: shared replay windows, channel state and rate limits are designed before this is built.], [Open],
  [v1.2.5], [Import from other databases], [the `import` command reads PostgreSQL and MySQL sources, by URL.], [Later],
)

=== v1.3 — JSON:API 1.1 and Dhall schemas

Additions only: clients of the 1.0 API keep working. Starts after v1.1.

#table(
  columns: (auto, 1fr, 1.3fr, auto),
  table.header([*Version*], [*Task*], [*Done when*], [*State*]),
  [v1.3.0], [JSON:API 1.1], [The server reports `jsonapi.version` `1.1`; accepts the `ext` and `profile` media type parameters and answers 415 or 406 for extensions it does not support, as 1.1 requires; accepts `lid` in create documents so a request can refer to a resource it creates; the HTTP suite covers each.], [Later],
  [v1.3.1], [Atomic operations], [The atomic operations extension (`https://jsonapi.org/ext/atomic`): several creates, updates and deletes in one request, applied in one transaction, each checked against access rules and audited, with `lid` references between them.], [Later],
  [v1.3.2], [Dhall schema files], [`.dhall` files are read beside `.json` and `.yaml`, evaluated to JSON Schema and checked by the meta-schema; a typed Dhall package for SRS keywords (`x-access`, `x-relations`, …) lets mistakes fail before `init`. The schema fingerprint covers the evaluated schema, so formatting changes do not force a migration.], [Later],
)

=== v2.0 — Post-quantum cryptography

A new wire format, so a major version: `srs-noise-v2`, `srs-cert-v2` and
`srs-req-v2`. Every change is hybrid: a classical and a post-quantum
algorithm are combined, so the result is no weaker than today if either one
is broken. Starts after v1.1, in the Rust protocol crate, with the TypeScript
client following through WebAssembly.

#table(
  columns: (auto, 1fr, 1.3fr, auto),
  table.header([*Version*], [*Task*], [*Done when*], [*State*]),
  [v2.0.0], [Hybrid transport], [The handshake adds an ML-KEM-768 exchange to X25519 (a hybrid NK pattern, following PQNoise and the Noise hybrid forward-secrecy patterns), with the server's ML-KEM key in its key bundle and fingerprint. Recorded traffic stays confidential against a future quantum computer. Conformance cases cover it.], [Later],
  [v2.0.1], [Hybrid signatures], [Identity, session and server keys become Ed25519 plus ML-DSA-65 pairs; a signature verifies only if both parts do. The cost, measured and recorded: an ML-DSA-65 signature is 3,309 bytes on every signed request and on every retained write.], [Later],
  [v2.0.2], [Hybrid key rotation], [A server moves from a classical to a hybrid key bundle through a signed transition (@server-key-rotation), so pinned clients follow without repinning.], [Later],
  [v2.0.3], [Post-quantum passwords], [Open: OPAQUE is classical. Its messages already travel inside the hybrid channel, so recorded logins stay confidential, but it is not secure against an active quantum attacker. Replace it once a post-quantum asymmetric PAKE is standardised (the CFRG draft CPaceOQUAKE+ is a candidate) and has a maintained implementation.], [Open],
)
