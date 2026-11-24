== Transport <transport>

Status: *Specified*.

=== Decision

Under `SRS_TRANSPORT=noise`, all traffic after the handshake runs through a
Noise channel that authenticates the server by a pinned key, encrypts every
request and response, and carries forward secrecy. TLS is not required.

=== Primitives

- Handshake: `Noise_NK_25519_ChaChaPoly_BLAKE2s`.
- Prologue: the ASCII string `srs-noise-v1` followed by the 32-byte server key
  fingerprint.
- Signatures (@requests): Ed25519.
- Hashes outside Noise: SHA-256. Key derivation: HKDF-SHA256.

NK is the pattern for a client that knows the server's static key in advance
and has none of its own. The client's identity is established inside the
channel by OPAQUE (@accounts), not by Noise.

=== Server keys <server-keys>

`srs init` creates a server key bundle and prints its fingerprint:

- an X25519 static key for Noise;
- an Ed25519 signing key, used to sign key rotations (@server-key-rotation)
  and, optionally, responses.

The fingerprint is SHA-256 of `srs-keys-v1 ‖ x25519_public ‖ ed25519_public`,
written as `srs1:` followed by base32. Clients are configured with it:
`createClient({ url, serverKey: "srs1:…" })`. `GET /noise/keys` returns the
public bundle in the clear as JSON (`version`, `x25519`, `ed25519` in
base64url, and `fingerprint`); the client accepts it only if it hashes to the pinned
fingerprint. The bundle is held in the `SRS_SERVER_KEYS` setting as `srs-keys-v1:`
followed by the base64url of its 64 secret bytes (the X25519 private key, then
the Ed25519 seed), outside the database like `OPAQUE_SERVER_SETUP`, and backed up
separately.

=== Handshake

```text
client                                        server
POST /noise/handshake   msg1: e, es  ───────►
                        ◄───────  msg2: e, ee ‖ payload { sid }
```

- `sid` is 16 random bytes naming the channel. It is not a secret.
- After `msg2`, both sides hold two transport keys, `k_c2s` and `k_s2c`, and
  the handshake hash `h`. `h` identifies this channel and is bound into login
  (@login) and into every signature (@requests).
- A failed handshake returns `400` with no detail.
- Handshakes are rate-limited per client address, like logins.
- Channels that are not authenticated by a login within 10 minutes are
  dropped.

=== Envelope

Every later request is `POST /noise` with content type
`application/vnd.srs.noise` and this body:

```text
"SRS1" ‖ sid (16) ‖ n (8, big-endian) ‖ ciphertext
ciphertext = ChaCha20-Poly1305(k_c2s, nonce = n, ad = "SRS1" ‖ sid ‖ n, plaintext)
```

The plaintext holds the method, path with query string, the headers the
application needs (`content-type`, `accept`), the body, and, once logged in,
the request signature (@requests). Paths are therefore hidden from the network.

The server decrypts, checks the counter (@replay), and passes an ordinary
request to the application. The response is:

```text
"SRS1" ‖ sid ‖ n ‖ ChaCha20-Poly1305(k_s2c, nonce = n, ad = "SRS1" ‖ sid ‖ n, response)
```

using the same `n` as the request, so a response cannot be attached to another
request or another channel. The response plaintext holds the status, the
headers the client needs, and the body.

Noise permits explicit nonces for transports that deliver out of order; this
is that case. Each key encrypts a given nonce at most once, because a request
counter is accepted at most once and a response reuses only its own request's
counter under the other key.

=== Replay and ordering <replay>

The server keeps, per channel, the highest counter seen and a 1024-bit window
of the counters below it, as WireGuard does.

- A counter already seen, or below the window, is rejected.
- Counters may arrive out of order within the window, so concurrent requests
  work.
- The client increments its counter for every request, including retries. A
  retry is a new request; whether repeating a write is safe is the
  application's concern.
- A rejected envelope is answered `409` in the clear without detail, and the
  client starts a new request.

=== Channel lifetime

- A channel ends after 24 hours, after $2^32$ requests, after its login ends,
  or when the server restarts. Channel keys and windows live only in memory.
- The client then runs a new handshake and resumes its login (@resume) without
  asking for the password again.
- An unknown or ended `sid` is answered `401` in the clear. Because this answer
  is not authenticated, an active attacker can forge it; the only effect is an
  extra handshake.

=== Strict mode

Under `noise`, the server refuses every request that is not one of the clear
routes listed in @http-api, and the client refuses to send anything outside the
channel. There is no fallback, so an attacker cannot remove the encryption by
making each side believe the other lacks it.
