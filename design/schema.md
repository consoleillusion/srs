# Schema generation

## Decision

JSON Schema is the only source of truth for the database and API. Schema files
declare columns, relations, access rules and read-only views; the generator
derives everything else.

## Pipeline

```text
loadSchemas -> deriveSchemas -> buildSchema -> buildViews / planMigration
```

- `loadSchemas` reads `.json`, `.yaml` and `.yml` files and resolves `$ref`.
- `deriveSchemas` creates join tables and inferred inverse relations.
- `buildSchema` creates ordered table definitions, views, triggers and indexes.
- `planMigration` compares the built schema with the recorded database state.

## Decisions

- A schema `title` becomes a snake_case table name and resource type.
- `one` relations add a foreign-key column when one is not declared.
- `many` relations use a join table unless an inverse `one` relation exists.
- Relation and access declarations are validated before any SQL is generated.
- Table, column and relation names are snake_case.
- Generated SQL files are never edited; change the schema and regenerate.
- A schema change is the only normal reason to add a migration.

## Consequences

The build is deterministic and migration generation is idempotent. The same
built schema drives both the migration writer and the running application.

The detailed keyword reference is in [schema-reference.md](../doc/schema-reference.md).
