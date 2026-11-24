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
- Conformance: a protocol suite of independent fixtures from a Python
  reference, including the published Noise vectors.

=== Specified, not built

Everything with state *Next*, *Later* or *Open* in @roadmap.

=== Known gaps in what is built

- In the bearer transport, the session public key sent at login is not bound
  to the OPAQUE exchange, so an active attacker can replace it. The bearer
  transport requires TLS, which prevents this; the Noise transport removes the
  gap by design (@login).
- A parent's owner cannot moderate inherited child rows.
- The secure client has been run in Bun and over real HTTP, not yet in a real
  browser (v0.3.13).
- The container image, CI on GitHub and a real identity provider have not
  been checked (v0.2.2 to v0.2.4).

=== Open questions

- Where the expected outputs of the schema-engine, query-compiler and access
  suites (v0.5.2 to v0.5.4) come from. @implementation requires fixtures to
  come from an implementation other than the one under test, as the protocol
  fixtures do. For these suites that means a second schema engine and query
  compiler, in Python, which is a large piece of work. The alternative is
  approved golden files: produced once by the TypeScript implementation, read
  and approved by a person, and changed only through review. That would need a
  decision row relaxing the rule for these suites.
- Whether providers likely to be used with SRS support DPoP, which would let
  provider users sign requests (@external-identity).

=== Verification plan

The transport and account protocol is a new composition of standard parts. It
is accepted when the following hold; @roadmap tracks them as v0.3 and v0.6.

+ The Noise handshake passes the published Noise test vectors for
  `Noise_NK_25519_ChaChaPoly_BLAKE2s`.
+ Every rule in @transport, @accounts and @requests has a test, including
  these attacks: replayed, reordered, truncated and cross-channel envelopes;
  responses swapped between requests; a login relayed through a second
  channel; a swapped session key; a certificate from another channel or
  login; a revoked identity key; a downgrade to a clear route; a forged
  key-rotation statement.
+ The handshake, binding and certificate steps are modelled in a protocol
  analysis tool (Tamarin or ProVerif), and the properties in @threat-model are
  proved for that model.
+ An external reviewer who does protocol review has read this book and the
  code.
