# HTTP API

## Decision

Serber exposes JSON:API 1.0 over Hono. Generic routes are generated from the
exposed resources in the built schema; authentication uses a small plain-JSON
surface under `/key`.

## Rules

- Resource types are snake_case table names.
- `GET` and `HEAD` read from generated views; the API does not join base tables
  at request time.
- `POST`, `PUT`, `PATCH` and `DELETE` validate the JSON:API document against
  resource metadata before writing.
- Collections support pagination, sorting, filtering, sparse fieldsets and
  `include`.
- Relationship filters and includes apply the viewer’s read access at every
  step.
- Hidden resources, columns and relations are absent from routes, the catalog,
  queries and responses.
- Unknown or unreadable resources and IDs return `404`; invalid input returns
  `400`; constraint violations return `409`.
- Generic responses use `application/vnd.api+json`. Auth success bodies use
  `application/json`; auth errors use the JSON:API error format.

## Consequences

There are no per-resource controllers to keep in sync. Adding or hiding a
resource changes the API surface through the schema, not through route code.

See [api.md](../doc/api.md) for the full endpoint and query contract.
