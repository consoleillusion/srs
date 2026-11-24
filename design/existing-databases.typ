== Existing databases <existing-databases>

Status: *Specified* for SQLite; PostgreSQL and MySQL follow pluggable
databases (@implementation). The questions under _Open_ must be settled before
the matching parts are built.

=== Decision

`srs import <source> --owner <username> [--out schemas]` reads an existing
database and gives it an SRS API in two steps:

+ *Schemas.* It writes one JSON Schema file per table into `--out`, from the
  table's columns, keys and foreign keys. The files are ordinary schemas: the
  user reviews them, adds `x-access` rules, and can change anything before
  continuing.
+ *Data.* `srs init` builds the SRS database from those schemas, adding SRS's
  own columns, system tables and views. `srs import --data` then copies the
  rows across. The source database is only ever read.

Copying, rather than serving the source database in place, keeps the source
safe: SRS needs its own columns on every table (`id`, `owner`, `visibility`,
`updated_at`) and its own tables, and adding those to a live database another
application uses could break it.

=== Mapping

#table(
  columns: (1fr, 2fr),
  table.header([*Source*], [*Schema*]),
  [Table], [One schema; `title` from the table name. A name that clashes with a system table (`user`, `key`, …) gets the suffix `_imported`.],
  [`INTEGER`, `BIGINT`, `SMALLINT`], [`type: integer`],
  [`REAL`, `FLOAT`, `DOUBLE`], [`type: number`],
  [`NUMERIC`, `DECIMAL`], [`type: number`; values that need exact decimals are reported, because they lose precision],
  [`TEXT`, `CHAR(n)`, `VARCHAR(n)`], [`type: string`, with `maxLength: n` when given],
  [`BOOLEAN`], [`type: boolean`],
  [`DATE`, `DATETIME`, `TIMESTAMP`], [`type: string`, `format: date-time`],
  [`BLOB`], [`type: string`, base64; reported, since binary columns are rarely useful over JSON],
  [`NOT NULL`], [the column is `required`],
  [`UNIQUE`], [`x-unique: true`],
  [Primary key], [kept as a unique column named `source_id`; SRS adds its own `id`],
  [Foreign key], [a `one` relation (`x-relations`) to the referenced table],
  [Indexes, `CHECK` constraints, views, triggers], [not imported; each is listed in the import report],
)

=== Rows

- Each row gets a new `id`. Its old primary key is kept in `source_id`, so
  other systems can still find it.
- Foreign keys are rewritten from old primary keys to the new ids.
- Every imported row is owned by `--owner`, which must be an existing user,
  usually an admin, and gets the schema's default visibility (`private` unless
  the schema says otherwise). The owner can then open rows up through the API.
- The import runs in one transaction and writes a report of everything it
  changed or left out.

=== Open

- *Serving a database in place.* Whether SRS should also be able to serve an
  existing database live, instead of a copy, and how it would add its columns
  without disturbing the other applications using it.
- *Keeping a copy in step.* Whether `--data` should be repeatable, copying only
  rows changed since the last run.
- *Owners per row.* Whether a source column (such as `created_by`) can be
  mapped to owners, matching usernames.
