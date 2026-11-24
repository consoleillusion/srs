# SRS design

Goals, constraints and the decisions behind SRS. The detailed reference for
the schema, API, authentication and operations is in [doc](../doc/README.md);
the project overview and quick start are in the [root README](../README.md).

| Document | What it records |
| --- | --- |
| [Goals](./goals.md) | What SRS is for, its constraints, and what it leaves out |
| [Decisions](./decisions.md) | The numbered decision log; add a row before changing a rule |
| [Schema](./schema.md) | JSON Schema as the source of truth |
| [Migrations](./migrations.md) | Deterministic, immutable, generated migrations |
| [Authentication](./authentication.md) | OPAQUE, request signing and external identity providers |
| [HTTP API](./http-api.md) | The generated JSON:API surface |
| [Authored views](./authored-views.md) | Read-only views declared in schema |
