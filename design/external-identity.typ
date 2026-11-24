= External identity providers <external-identity>

Status: *Implemented* in the bearer transport.

== Decision

In the bearer transport, SRS can also accept bearer JWTs from one OpenID
Connect provider, such as Keycloak, Kanidm, Authentik, Zitadel, Auth0 or Entra
ID. The provider then owns passwords, multi-factor sign-in, recovery and
session lifetime.

This mode is weaker than the Noise transport and is opt-in:

- A provider token is a bearer token. Anyone who copies it can use it until it
  expires, so this mode requires TLS.
- There is no client key, so requests cannot be signed and resources with
  `x-access.signed` refuse them. Nothing a provider user does is
  non-repudiable.

It is not available under `noise`. A standards-based way to bind provider
tokens to a client key, DPoP (RFC 9449), would close the gap if the chosen
provider supports it; that is *Open* (@status).

== Rules

- `SRS_OIDC_ISSUER` and `SRS_OIDC_AUDIENCE` turn the mode on. The issuer must
  be https, except on localhost, and its discovery document is fetched at
  startup, so a wrong issuer stops the server.
- Only asymmetric signature algorithms are accepted. Issuer, audience,
  signature, `sub` and `exp` must be valid, with 30 seconds of clock tolerance.
  Every failure is the same `401`.
- A bearer token containing a `.` is checked against the provider; anything
  else is a built-in session id.
- The first valid token for a `sub` creates a user whose username is derived
  from the issuer and subject, never from a claim, so a provider identity
  cannot take over a built-in username or the admin rights tied to one.
- An email is stored only when the provider marks it verified.
- `SRS_OIDC_ADMIN_SUBJECTS` grants admin by subject, for the configured issuer
  only.
