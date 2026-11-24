== Access control <access-control>

Status: *Implemented*. The meaning of `signed` under the Noise transport is
*Specified* (@requests).

=== Decision

Authorization is declarative and central. Each resource carries an `x-access`
object; every key is optional and its absence gives the secure default.

#table(
  columns: (auto, auto, 1fr),
  table.header([*Key*], [*Default*], [*Meaning*]),
  [`read`], [`session`], [`public` lets requests without a session read rows whose visibility is `public`.],
  [`create`], [`session`], [`public` allows anonymous creates; `role` limits creates to role holders; `none` means only the server creates rows.],
  [`visibility`], [all values], [The visibilities an owner may choose.],
  [`defaultVisibility`], [`private`], [The visibility a new row gets.],
  [`shareable`], [`false`], [Derives a share table so owners can grant read or write to users and groups.],
  [`signed`], [`false`], [Operations whose signatures are always retained, and which are refused without a signature (@requests).],
  [`roles`], [none], [Role name to operations; holders may perform them on every row.],
  [`inherit`], [none], [A to-one relation: whoever can read the parent can read this row.],
  [`audited`], [`false`], [Operations recorded in `audit_log`.],
)

=== Rules

- The owner is the creator and is never set by a client.
- Updates need ownership or a write share. Deletes, visibility changes and
  share management need ownership.
- A row is readable by its owner; by anyone if `public`; by any signed-in user
  if `authenticated`; by holders of a read share if `shared`.
- Embedded related rows follow the same rule.
- Rows the caller cannot read return `404`, never `403`, so their existence is
  not revealed. A forbidden operation on a readable row returns `403`.
- Roles come from `user_role` rows, which only admins manage, and from the
  configured admin list. Groups never confer roles.
- Inheritance applies to reads only, to at most three levels.
- Audited writes and their audit rows commit in one transaction.

=== Known limits

- A parent's owner cannot moderate child rows they do not own.
- `audit_log` is append-only through the API but not protected by database
  triggers.
