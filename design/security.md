# Security

## Decisions

- **OPAQUE** keeps passwords off the wire and out of server storage.
- **Central authorization** applies owner, visibility, share, role and inherited
  access checks in one place.
- **Hide by construction** removes hidden resources from every surface rather
  than relying on per-handler checks.
- **Parameterized SQL** is used for values; there is no raw user SQL.
- **Signed requests** use Ed25519 over method, path, session, timestamp, nonce
  and body hash. Signing is opt-in per resource and operation.
- **Audited writes** append to `audit_log` in the same transaction as the
  change.
- **Immutable migrations** and a recorded schema state protect the database
  contract.

## Threat model

The primary threats are password theft, replay, forged or replayed requests,
privilege escalation, SQL injection, credential stuffing and migration
corruption. Each has a corresponding mitigation in the source and test suite.

## Known gaps

- No key rotation or revocation API.
- No multi-device sessions or refresh tokens.
- The audit log is append-only through the API, not enforced by database
  triggers.
- A parent owner cannot moderate inherited child rows they do not own.
- Related scalar fields projected by authored views are not filtered by the
  related row’s read policy.
- Login rate limiting keys clients by socket address; deployments behind a
  trusted proxy need a deliberate client-identity policy.

See [security.md](../doc/security.md) for the full threat table.
