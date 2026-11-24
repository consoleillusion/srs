== Status and verification <status>

Status: *Implemented* — kept current with every change.

=== Built

Schema generation, relations, views, migrations, the JSON:API, access
control with sharing, roles, inheritance and audit, OPAQUE registration and
login, per-resource signed requests, the bearer transport, OIDC bearer
tokens, request limits, rate limiting, health checks, request logging,
backups and restore.

=== Specified, not built

Everything with state *Next*, *Later* or *Open* in @roadmap.

=== Known gaps in what is built

- In the bearer transport, the session public key sent at login is not bound
  to the OPAQUE exchange, so an active attacker can replace it. The bearer
  transport requires TLS, which prevents this; the Noise transport removes the
  gap by design (@login).
- A parent's owner cannot moderate inherited child rows.
- There are no metrics (v0.2.5).

=== Open questions

- Whether `@serenity-kit/opaque` accepts a context value, which would bind the
  channel inside OPAQUE itself in addition to the binder.
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
