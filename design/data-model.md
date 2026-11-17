# Data model

## Every table

The generator injects:

- `id` — UUIDv7, stored as a 16-byte blob and exposed as a canonical UUID
  string;
- `updated_at` — Unix milliseconds, refreshed by a trigger;
- `owner` — nullable UUID foreign key to `user.id`, indexed, `ON DELETE SET
  NULL`.

Exposed tables also receive `visibility`, constrained to the values allowed by
their `x-access` settings.

## Decisions

- UUIDv7 is the only primary-key strategy. Its timestamp replaces `created_at`.
- `owner` records the signed-in creator and is read-only through the API. A
  client-supplied owner is ignored.
- `owner` points at users only. Groups receive shares, never ownership.
- Deletion behaviour is a foreign-key concern: deleting a user keeps rows by
  setting `owner` to null.
- `x-exposed: false` hides a table, column or relation from every public
  surface, including relations that target it.
- Every exposed table gets a `<table>_view`. Reads use views; writes use base
  tables.

## System tables

The built-in schemas define `user`, `user_group`, `key`, `user_role`,
`audit_log`, `request_nonce`, `auth_limit` and `schema`. `key` is hidden and is
reachable only through `/key` authentication routes.

Detailed columns and deletion rules are in [data-model.md](../doc/data-model.md).
