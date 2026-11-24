# Design

These documents record the goals and decisions behind SRS. They are
hand-maintained, deliberately short, and normative when they say “must”.

Detailed behaviour lives in the [reference docs](../doc/README.md). Generated
TypeScript API documentation is written to [doc/](../doc) by `bun run docs`.

## Maintaining these documents

- Change a design document when the decision changes, not when an
  implementation detail changes.
- Keep each document short. Link to detailed reference material instead of
  copying it.
- Record contentious or reversible choices in [decisions.md](./decisions.md).
- If a rule can be tested, add a test. If it cannot, say why.
- Do not describe incidental behaviour as a promise.

## Index

1. [Goals](./goals.md) — what the project is for, and what it is not.
2. [Schema generation](./schema.md) — schema as the source of truth.
3. [Data model](./data-model.md) — injected columns, IDs, ownership and views.
4. [Authored views](./authored-views.md) — read-only projections over tables.
5. [Access control](./access-control.md) — visibility, shares, roles and audit.
6. [Authentication](./authentication.md) — OPAQUE, sessions and key storage.
7. [HTTP API](./http-api.md) — JSON:API routes, queries, writes and errors.
8. [Migrations](./migrations.md) — deterministic, immutable database changes.
9. [Security](./security.md) — threats, mitigations and known gaps.
10. [Decision log](./decisions.md) — the short list of decisions we rely on.
