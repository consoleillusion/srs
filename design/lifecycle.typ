= Account lifecycle <lifecycle>

Status: *Specified*. Ending one bearer session is *Implemented*.

All operations here are signed requests in a logged-in channel unless stated
otherwise, and all are audited.

== Logout

The client sends `DELETE /login/current`. The server marks the login record
ended and drops every channel using it. The client discards its session key,
identity key and login id.

== Devices

`GET /login` lists the user's unended logins (created, expires, last used).
`DELETE /login/:id` ends one, dropping its channels. Ending every other login
is `DELETE /login?others=true`.

== Password change

+ The client runs OPAQUE registration again inside the channel, getting a new
  registration record and export key.
+ It wraps the _same_ identity key under the new wrap key.
+ It sends the new record and the new wrapped key, signed.
+ The server replaces both in one transaction and, unless the client asks
  otherwise, ends every other login.

The identity key does not change, so every earlier signature stays valid.

== Revocation <revocation>

A user who believes their identity key or password is compromised revokes the
identity key. Revocation is signed by the current session, or done by an admin.

- The identity key row gets a `revoked_at` time.
- Every login certified by that key ends; new certificates for it are refused.
- Signatures made before `revoked_at` remain verifiable and are reported as
  _made before revocation_. Signatures after it are refused.
- The user then logs in with OPAQUE, which still works because the password
  is unchanged, and must change the password in the same step: the client runs
  a new OPAQUE registration, generates a new identity key, wraps it under the
  new export key, and registers it with a proof of possession. Until that
  completes, the login can do nothing else.

If an attacker also knows the password, they can race the user to this step.
An admin reset (@recovery) settles the race.

== Forgotten password <recovery>

OPAQUE cannot recover a password, and without the password the identity key
cannot be unlocked. Recovery therefore creates a new identity key:

+ An admin issues a reset token for the user: 32 random bytes, single use,
  valid for one hour, stored only as a hash. The admin hands it to the user
  out of band.
+ The user, in a channel, sends the token with a new OPAQUE registration, a new
  wrapped identity key and its proof of possession.
+ The server consumes the token, replaces the OPAQUE record, marks the old
  identity key _retired_ (not revoked) and registers the new one. All logins
  end.

Signatures made with the retired key stay valid. An admin who issues a reset
can sign in as the user afterwards; this cannot be prevented while recovery
exists. It is mitigated by recording every reset in the audit log and showing
it to the user at their next login, and verifiers treat signatures made after
an admin reset as accountable to the reset as well as to the user.

Deployments that need stronger guarantees can disable admin resets with
`SRS_ALLOW_RESET=false`; a forgotten password then means a new account.

== Server key rotation <server-key-rotation>

+ The operator runs `srs rotate-keys`, which creates a new key bundle and a
  _transition statement_: the new bundle and the date the old one stops being
  accepted, signed by the old server signing key.
+ `GET /noise/keys` returns the current bundle and any transition statement.
+ A client pinned to the old fingerprint verifies the statement with the old
  signing key and replaces its pin.
+ After the stop date, the server answers handshakes only with the new key.

If a server key is stolen, a transition statement cannot be trusted, because
the thief can sign one. Clients must then be given the new fingerprint out of
band.

== Accounts are not deleted

Users that own keys cannot be deleted (@schema), so that retained signatures
stay attributable. An admin can _disable_ a user: every login ends and logins
are refused. Personal data columns can be cleared; the user id, identity key
history and certificates remain.
