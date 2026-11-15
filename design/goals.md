# Goals

## Product goal

Turn a folder of JSON Schema files into a secured backend: generated Turso /
SQLite tables, relations, views and migrations, OPAQUE authentication,
owner-based authorization, and a JSON:API served by Hono. Application authors
should write schema, not CRUD handlers.

## Goals

- **Schema is the source of truth.** Tables, relations, views, migrations and
  API resources are derived from schema files.
- **Secure by default.** New resources are private, session-readable, and not
  shareable unless explicitly opened up.
- **Deterministic generation.** The same schemas produce the same database
  objects and SQL in the same order.
- **One runtime contract.** Migration generation and the running server consume
  the same built schema, so the database and API cannot drift.
- **Hide by construction.** Hidden tables, columns and relations are absent from
  the registry, catalog, queries and responses, not filtered ad hoc.
- **Small, focused modules.** Keep generation, storage, HTTP and auth concerns
  behind clear boundaries.
- **Behaviour is tested.** The suite covers generation, migrations, API,
  authorization, auth and the client.

## Constraints

- No raw user SQL is executed.
- Passwords never leave the client.
- Generated migrations are not edited by hand.
- Applied migrations are immutable.
- The API is JSON:API 1.1; authentication success bodies are plain JSON.
- `owner` always references `user.id`, never a group.

## Non-goals

- A general-purpose ORM, SQL console or query builder.
- Hand-written CRUD handlers for every resource.
- A configurable policy language beyond the `x-access` model.
- Treating the presence of a hidden row as public information.

See [decisions.md](./decisions.md) for the decisions that support these goals.
