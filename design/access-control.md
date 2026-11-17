# Access control

## Decision

Authorization is declarative, per resource, and evaluated centrally. Every
resource may carry `x-access`; omitted keys take secure defaults.

| Key | Default |
| --- | --- |
| `read` | `session` |
| `create` | `session` |
| `visibility` | private, authenticated, public |
| `defaultVisibility` | `private` |
| `shareable` | `false` |
| `signed` | `false` |
| `roles` | `{}` |
| `audited` | `false` |

## Rules

- The owner is the signed-in creator. Clients cannot set it.
- A row is readable by its owner, by anyone when `public`, by signed-in users
  when `authenticated`, and by users or groups holding a read share when
  `shared`.
- Shares grant `can_read` and/or `can_write`; only the owner manages them.
- Roles grant operations across every row, whoever owns it.
- `inherit` follows a to-one parent for reads, up to three levels.
- Audited writes append to `audit_log` in the same transaction.
- Signed operations require a valid Ed25519 signature, timestamp and unused
  nonce.
- Unreadable rows return `404`; forbidden operations on readable rows return
  `403`.

## Known gap

A parent’s owner cannot moderate inherited child rows they do not own.

See [access-control.md](../doc/access-control.md) for the full matrix and
signing message format.
