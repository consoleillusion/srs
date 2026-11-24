# Authored views

## Decision

An authored view is a read-only resource declared in schema. It projects fields
and direct relations from a base table without hand-written SQL.

`x-view: true` is the discriminator. A top-level `x-source` is interpreted only
when `x-view` is true; on a table it is ignored.

## Rules

- Every view has `x-source: "<base-table>"`.
- Every property has an `x-source` path beginning with `<base>.`.
- `id`, `owner` and `visibility` are mandatory and must come directly from the
  base row.
- A column path may follow `one` relations, such as `article.author.name`; it may
  not cross a `many` relation.
- A relation-valued property must name a direct relation of the base table. Use
  `type: object` for `one` and `type: array` for `many`.
- Views may not declare `x-relations`, be shareable, inherit access, or be
  created through the API.
- A view may read only exposed tables, columns, relations and join tables.

## Access

Reads inherit the base table’s `read`, `signed` and `roles` policy. A view may be
stricter, but it cannot make a session-only table public or drop a signature or
role requirement. Writes return `405`.

## Known limits

- Nested relation-valued properties are rejected.
- A scalar column projected through a related row is not filtered by that
  related row’s read policy.
- The database view materialises every embedded relation, even when the request
  uses a sparse fieldset.

See [schema-reference.md](../doc/schema-reference.md) for the complete rules.
