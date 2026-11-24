== Schema <schema>

Status: *Implemented*.

=== Decision

JSON Schema is the only source of truth for the database and the API. Schema
files declare columns, relations, access rules and read-only views; the
generator derives everything else.

=== Rules

- A schema `title` becomes a snake_case table name and resource type.
- Table, column and relation names are snake_case.
- Every table has `id` (a UUIDv7 stored as a 16-byte blob), `updated_at` and
  `owner`. Exposed tables also have `visibility`.
- `one` relations add a foreign-key column when one is not declared.
- `many` relations use a join table unless an inverse `one` relation exists.
- `x-exposed: false` removes a table, column or relation from every API
  surface at build time.
- Relation and access declarations are validated before any SQL is generated.
- System schemas (`user`, `user_group`, `key`, `user_role`, `audit_log`,
  `request_nonce`, `auth_limit`, `schema`) are always loaded. Account and
  transport state lives in hidden system tables, never in exposed ones.
- Key history is kept: a user that owns keys cannot be deleted
  (`onDelete: restrict`), so every retained signature stays attributable
  (@requests).

=== Consequences

The build is deterministic and migration generation is idempotent. The same
built schema drives the migration writer and the running application. The full
keyword reference is in `doc/schema-reference.md`.
