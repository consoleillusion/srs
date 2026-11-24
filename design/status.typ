== Status and verification <status>

Status: *Implemented* — kept current with every change.

=== Built

- Schema generation, relations, views, deterministic migrations, a meta-schema
  check of every schema file, generated TypeScript types and a descriptive
  catalog.
- The JSON:API, and access control with visibility, sharing, roles,
  inheritance, and an append-only audit log.
- The Noise transport, the default: pinned server keys, the NK handshake,
  sealed requests and responses, replay protection and strict mode.
- Accounts over it: OPAQUE with identity keys, logins bound to the channel,
  session certificates, resume, every request signed and retained, an offline
  signature verifier, and the full account lifecycle, including revocation,
  admin resets, disabling users and server key rotation.
- The bearer transport for TLS deployments, with optional OIDC bearer tokens.
- Operations: request limits, rate limiting, health checks, request logging,
  metrics, backups and restore, graceful shutdown, CI and a container image.
- The `console` command, a browser page for using a server over the Noise
  transport, and `bun run try`, which starts a server and the console
  together; both are tested in headless Chrome, including without
  `crypto.subtle`.
- Conformance: a protocol suite of frozen fixtures, including the published
  Noise vectors.

=== Specified, not built

Everything with state *Next*, *Later* or *Open* in @roadmap.

=== Known gaps in what is built

- In the bearer transport, the session public key sent at login is not bound
  to the OPAQUE exchange, so an active attacker can replace it. The bearer
  transport requires TLS, which prevents this; the Noise transport removes the
  gap by design (@login).
- A parent's owner cannot moderate inherited child rows.
- Running the container image with a mounted project, and a real identity
  provider, have not been checked (v0.2.3, v0.2.4).
- Existing databases cannot be imported yet (v0.4.5, v0.4.6), and only the
  embedded SQLite database is supported (v1.2).

=== Open questions

- Whether providers likely to be used with SRS support DPoP, which would let
  provider users sign requests (@external-identity).

=== How the protocol is checked

SRS is checked by working code, tests and use over time, not by outside
review. The transport and account protocol is accepted while all of these
hold:

+ The Noise handshake passes the published Noise test vectors for
  `Noise_NK_25519_ChaChaPoly_BLAKE2s`.
+ Every rule in @transport, @accounts and @requests has a test, including
  these attacks: replayed, reordered, truncated and cross-channel envelopes;
  responses swapped between requests; a login relayed through a second
  channel; a swapped session key; a certificate from another channel or
  login; a revoked identity key; a downgrade to a clear route; a forged
  key-rotation statement.
+ The protocol conformance suite passes.
+ Every problem found in real use gets a test that would have caught it.
