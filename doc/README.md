# SRS documentation

This directory contains the detailed documentation for SRS's generated data
model, HTTP API, access control, and authentication layer. The root
[README](../README.md) is the project overview and quick start; the
[design book](../design/README.md) decides goals, rules and the security
protocol; where this reference and the book differ, the book describes the
intended design and this reference describes what is built.

TypeDoc writes the generated TypeScript API reference into this directory
(`bun run docs`).

## Reading order

1. [Architecture](./architecture.md) — how schemas become tables, views,
   migrations, and HTTP routes, plus the design invariants.
2. [Data model](./data-model.md) — injected columns, system tables, relations,
   views, and the hidden key store.
3. [Schema reference](./schema-reference.md) — every supported JSON Schema
   keyword, relations, and validation rules.
4. [Access control](./access-control.md) — `x-access`, visibility, sharing,
   roles, inheritance, audit, and signed requests.
5. [API](./api.md) — JSON:API endpoints, queries, writes, errors, and status
   codes.
6. [Authentication](./auth.md) — the OPAQUE registration/login flows, session
   lifecycle, keypairs, TTLs, and response shapes.
7. [Client](./client.md) — the browser-safe client: registration, login,
   sessions, storage, requests, and signing.
8. [Security](./security.md) — key ownership, non-repudiation, threat model, and
   known gaps.
9. [Development](./development.md) — setup, commands, migrations, tests, and
   conventions.
10. [Deployment](./deployment.md) — settings, reverse proxy, health checks,
    backups, restore, and the container image.

## Current status

The server generates tables, relations, join tables, views, migrations, and
JSON:API endpoints from JSON Schema. It implements OPAQUE registration and
login, owner-based authorization with per-row visibility, sharing, roles,
inherited read access, audit trails and opt-in request signing, and accepts
bearer tokens from an OpenID Connect provider. A browser-safe client is
available at `resource-server/client`. The server ships with request limits,
security headers, CORS, rate limiting, health checks, request logging,
scheduled verified backups, a restore command, a container image and CI.

Planned work, its order, and what counts as done are in the roadmap chapter of
the [design book](../design/README.md), which is the only roadmap.
