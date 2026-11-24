# Authentication

## Decision

Use OPAQUE for password authentication and Ed25519 JWKs for request signing.
The application keeps no in-memory auth state: pending flows, key material and
sessions live in the hidden `key` table.

## Rules

- Passwords never leave the client.
- `POST /key` starts registration or login; `PATCH /key/:id` finishes it.
- Registration and login state expire after 10 minutes and are consumed once.
- Sessions expire after 24 hours. There is no refresh flow.
- Unknown usernames receive the same login-start response as known ones.
- Login state stores the server private JWK; the registration server private key
  is ephemeral and discarded.
- Login and session keypairs are destroyed when their key row expires or is
  deleted.
- Keys belong to users, never groups.
- Expired rows are purged when an auth flow starts or a key status is read.

## Non-repudiation

Key rows are deliberately retained. The `key.user` relation uses `ON DELETE
RESTRICT`, so deleting a user cannot silently erase key history.

## Not implemented

Refresh tokens, multi-device session management, and key rotation or revocation
APIs.

See [auth.md](./auth.md) and [security.md](./security.md) for details.
