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

## External identity providers

SRS also accepts bearer JWTs from one OpenID Connect provider
(`SRS_OIDC_ISSUER`). The provider owns passwords, multi-factor authentication,
recovery and session lifetime. SRS verifies each token, creates a local user the
first time it sees an issuer and subject, and derives the username from them so
an external identity cannot claim a built-in username. Those requests have no
client key, so signed resources reject them. Built-in OPAQUE accounts and a
provider can run together; a token containing a `.` is checked against the
provider and anything else is a built-in session id.

## Non-repudiation

Key rows are deliberately retained. The `key.user` relation uses `ON DELETE
RESTRICT`, so deleting a user cannot silently erase key history.

## Not implemented

Refresh tokens, multi-device session management, and key rotation or revocation
APIs.

See [auth.md](../doc/auth.md) and [security.md](../doc/security.md) for details.
