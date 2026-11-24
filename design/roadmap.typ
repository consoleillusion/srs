== Roadmap <roadmap>

Status: *Implemented* — this is the live list of work.

=== How to use this roadmap

- Milestones are done in order. A task may start when the tasks it depends on
  are done; dependencies are noted where they are not simply the task before.
- Each task has a _done when_ condition. A task is done only when that holds,
  the standard checks pass (@contributing), and this chapter is updated: the
  task's state set to *Done*, and the status lines of the chapters it touched
  updated.
- States are *Done*, *Next* (may start now), *Later* (blocked by earlier
  tasks) and *Open* (needs a design decision first; do not build).
- New work is added here before it starts, as a task with a done-when
  condition.

#table(
  columns: (auto, 1fr, auto),
  table.header([*Milestone*], [*Goal*], [*State*]),
  [M0], [Core: schema to tables, views, migrations, JSON:API, OPAQUE accounts, access control], [Done],
  [M1], [Production hardening of the current server], [In progress],
  [M2], [Secure transport and accountable accounts, in TypeScript], [Next],
  [M3], [Verification and wire-format freeze], [Later],
  [M4], [Schema authoring workflow], [Next, in parallel with M2],
  [M5], [Conformance suites], [Later; protocol fixtures start with M2],
  [M6], [Rust, piece by piece], [Later],
  [M7], [Pluggable databases], [Later],
)

=== M0 — Core

Done. Schema loading and derivation, relations, join tables, generated and
authored views, deterministic migrations, the JSON:API with filtering, sorting,
pagination, sparse fieldsets and includes, OPAQUE registration and login,
owner-based access control with visibility, sharing, roles, inheritance and
audit, per-resource signed requests in the bearer transport, and the
TypeScript client.

=== M1 — Production hardening

Built: request body limit, CORS, security headers, request rate limit,
proxy-aware client address, request logging with ids, health and readiness
routes, graceful shutdown, scheduled verified backups, `srs backup` and
`srs restore`, CI, container image, deployment reference, OIDC bearer tokens.

#table(
  columns: (auto, 1fr, 1.3fr, auto),
  table.header([*ID*], [*Task*], [*Done when*], [*State*]),
  [M1.1], [Make `key.user` `onDelete: restrict`], [The system schema says `restrict`; a migration is generated; a test shows deleting a user who owns keys fails with `409`.], [Next],
  [M1.2], [Verify CI on GitHub], [The workflow passes on a push to the repository.], [Next],
  [M1.3], [Verify the container image], [`docker build` succeeds; a container with a mounted project serves `/readyz` as `200`, takes a backup, and stops cleanly on `SIGTERM`. Steps recorded in `doc/deployment.md`.], [Next],
  [M1.4], [Verify OIDC against a real provider], [A Keycloak or Kanidm instance issues a token that SRS accepts; the exact provider settings, including issuer and audience, are recorded in `doc/auth.md`.], [Next],
  [M1.5], [Metrics], [With `SRS_METRICS_PORT` set, a second listener on `127.0.0.1` serves Prometheus text format: requests by route pattern and status, request duration histogram, login successes and failures, backup age. Off by default. Tests cover the output.], [Next],
  [M1.6], [Protect `audit_log` in the database], [Triggers make `UPDATE` and `DELETE` on `audit_log` fail; a test proves it.], [Next],
  [M1.7], [Ed25519 from `@noble/curves`], [`tweetnacl` is removed; signing and verification use `@noble/curves`; existing signing tests pass unchanged.], [Next],
)

=== M2 — Secure transport and accounts (TypeScript)

Specified in @transport, @accounts, @requests and @lifecycle. Every task adds
its attack tests from the list in @status as it goes.

#table(
  columns: (auto, 1fr, 1.3fr, auto),
  table.header([*ID*], [*Task*], [*Done when*], [*State*]),
  [M2.1], [Encoding helpers], [Length-prefixed field encoding and deterministic CBOR, with fixtures in `conformance/protocol/` (M5 format).], [Next],
  [M2.2], [Server key bundle], [`srs init` creates the bundle when `SRS_SERVER_KEYS` is unset and prints the `srs1:` fingerprint; `GET /noise/keys` serves the bundle; fingerprint fixtures exist.], [Later],
  [M2.3], [Noise NK handshake], [`POST /noise/handshake` works; the implementation passes the published `Noise_NK_25519_ChaChaPoly_BLAKE2s` test vectors; handshake rate limit in place.], [Later],
  [M2.4], [Envelope and replay window], [`POST /noise` decrypts into an ordinary request and encrypts the response; replay, reorder, truncation and cross-channel tests pass.], [Later],
  [M2.5], [Strict mode], [`SRS_TRANSPORT=noise` serves only the clear routes in @http-api; a downgrade test passes.], [Later],
  [M2.6], [Identity keys and registration], [Registration creates the wrapped identity key with proof of possession; a test shows a key without proof is refused.], [Later],
  [M2.7], [Bound login and certificates], [Login checks the binder, creates login records and accepts certificates per @certificates; relayed-login and swapped-key tests pass.], [Later],
  [M2.8], [Resume], [A client resumes after a server restart without the password; a certificate for an ended login is refused.], [Later],
  [M2.9], [Signing and retention], [Every request after login is verified; audit rows retain signatures and bodies per @retention; an offline verifier script checks a retained signature from the database alone.], [Later],
  [M2.10], [Client transport], [`createClient({ url, serverKey })` speaks the Noise transport end to end, in Bun and in a browser loaded from a trusted origin.], [Later],
  [M2.11], [Logout, devices, password change], [The routes in @lifecycle work, with tests.], [Later],
  [M2.12], [Revocation, admin reset, disabling users], [As specified in @lifecycle, including `SRS_ALLOW_RESET`, with tests.], [Later],
  [M2.13], [Server key rotation], [`srs rotate-keys` and transition statements work; a forged statement is refused.], [Later],
)

=== M3 — Verification and freeze

#table(
  columns: (auto, 1fr, 1.3fr, auto),
  table.header([*ID*], [*Task*], [*Done when*], [*State*]),
  [M3.1], [Protocol model], [A Tamarin or ProVerif model of the handshake, binding and certificates is in `verification/`, and proves the properties in @threat-model. Depends on M2.7.], [Later],
  [M3.2], [External review], [A protocol reviewer has reviewed this book and the M2 code; every finding is fixed or recorded as a decision.], [Later],
  [M3.3], [Freeze the wire format], [Every protocol string carries `v1`; the protocol fixtures are complete; the freeze is a decision row.], [Later],
  [M3.4], [Production soak], [One real deployment runs without a protocol change; findings are fixed.], [Later],
)

=== M4 — Schema authoring workflow

Makes adding a resource reliable for people and AI models. Independent of M2.

#table(
  columns: (auto, 1fr, 1.3fr, auto),
  table.header([*ID*], [*Task*], [*Done when*], [*State*]),
  [M4.1], [Schema validation], [Schema files are validated against a meta-schema of the supported keywords before any SQL is generated; every error names the file and the JSON pointer of the fault.], [Next],
  [M4.2], [Type generation], [`srs init` writes TypeScript types for every exposed resource, used by the client.], [Next],
  [M4.3], [Schema catalog], [The resource catalog at `GET /` describes each resource's attributes and relations.], [Next],
  [M4.4], [Templates], [Example schemas for common patterns (owned notes, shared documents, public catalog, chat with inherited messages) with tests that load them.], [Next],
  [M4.5], [Schema change guidance], [The schema reference explains which changes rebuild tables and which lose data.], [Next],
)

=== M5 — Conformance suites

Defined in @implementation. Protocol fixtures are written during M2.

#table(
  columns: (auto, 1fr, 1.3fr, auto),
  table.header([*ID*], [*Task*], [*Done when*], [*State*]),
  [M5.1], [Suite format and runner], [`conformance/README.md` defines the file format; a TypeScript runner runs every suite in CI.], [Next],
  [M5.2], [Protocol suite], [Complete for every message in Part III, including invalid inputs.], [Later],
  [M5.3], [Schema engine suite], [Schema folders with expected built schema, SQL and migration state.], [Later],
  [M5.4], [Query compiler and access suites], [Expected SQL, parameters and access decisions.], [Later],
  [M5.5], [HTTP suite], [The end-to-end tests drive the server over HTTP only, against a server started as a process.], [Later],
)

=== M6 — Rust, piece by piece

Order and switching rules in @implementation. Starts after M3.3 and M5.

#table(
  columns: (auto, 1fr, 1.3fr, auto),
  table.header([*ID*], [*Task*], [*Done when*], [*State*]),
  [M6.0], [Native-module proof of concept], [A `napi-rs` module loads in Bun on Linux, macOS and Windows and is built in CI. If Bun's Node-API support is insufficient, this is recorded and the plan is revisited before M6.1.], [Later],
  [M6.1], [`srs-protocol`], [Passes the protocol suite natively and as WebAssembly; `SRS_IMPL_PROTOCOL=rust` passes all tests.], [Later],
  [M6.2], [`srs-schema`], [Passes the schema engine suite; `SRS_IMPL_SCHEMA=rust`.], [Later],
  [M6.3], [`srs-query`], [Passes the query suite; `SRS_IMPL_QUERY=rust`.], [Later],
  [M6.4], [Access decisions], [Passes the access suite; `SRS_IMPL_ACCESS=rust`.], [Later],
  [M6.5], [`srs-store`], [Rust owns the database; all suites pass.], [Later],
  [M6.6], [`srs-server`], [The Rust binary passes the HTTP suite with no Bun process; released as a static binary.], [Later],
)

=== M7 — Pluggable databases

#table(
  columns: (auto, 1fr, 1.3fr, auto),
  table.header([*ID*], [*Task*], [*Done when*], [*State*]),
  [M7.1], [Choose the SQL layer], [A decision row selects `sqlx`, `sea-query` or both.], [Later],
  [M7.2], [PostgreSQL], [Every suite passes against PostgreSQL.], [Later],
  [M7.3], [MySQL], [Every suite passes against MySQL.], [Later],
  [M7.4], [Several processes], [Open: shared replay windows, channel state and rate limits are designed before this is built.], [Open],
)
