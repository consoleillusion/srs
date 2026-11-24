== Stack <stack>

Status: *Implemented* for the current stack; the planned libraries are
*Specified*.

=== Current stack

#table(
  columns: (auto, auto, 1fr),
  table.header([*Concern*], [*Choice*], [*Notes*]),
  [Runtime], [Bun 1.4 or newer], [Runs TypeScript directly; no build step. Also the test runner (`bun test`).],
  [Language], [TypeScript, strict], [Type-checked with `tsc --noEmit` (TypeScript 7).],
  [HTTP], [`hono`], [Routing and middleware: body limit, CORS, security headers.],
  [Database], [`@tursodatabase/database`], [SQLite-compatible, with the experimental `views`, `custom_types`, `encryption` and `vacuum` features. Beta software, accepted deliberately.],
  [Schema loading], [`@apidevtools/json-schema-ref-parser`, `yaml`], [Reads JSON and YAML schema files and resolves `$ref`.],
  [Validation], [`ajv`, `ajv-formats`], [Validates write documents and auth messages against JSON Schema.],
  [Passwords], [`@serenity-kit/opaque`], [OPAQUE, compiled to WebAssembly from the Rust `opaque-ke`.],
  [Signatures], [`tweetnacl`], [Ed25519 for request signing.],
  [Hashes], [`@noble/hashes`], [SHA-256 and HMAC.],
  [Provider tokens], [`jose`], [OIDC JWT verification (@external-identity).],
  [Settings], [`dotenv`], [Loads `.env` for the CLI.],
  [API reference], [TypeDoc (`bunx typedoc`)], [Fails on any undocumented export.],
  [Design book], [Typst], [`bun run design`.],
  [CI], [GitHub Actions], [Type-check, audit, docs, determinism, tests.],
  [Container], [`oven/bun` image], [Non-root, volumes for data and backups.],
)

=== Planned TypeScript libraries

Needed for the transport and accounts (@roadmap, series v0.3).

#table(
  columns: (auto, 1fr),
  table.header([*Library*], [*Use*]),
  [`@noble/curves`], [X25519 for Noise; Ed25519 for identity and session keys, replacing `tweetnacl` (v0.2.7).],
  [`@noble/ciphers`], [ChaCha20-Poly1305 for Noise; XChaCha20-Poly1305 for identity-key wrapping.],
  [`@noble/hashes`], [BLAKE2s for Noise; HKDF-SHA256 and HMAC-SHA256.],
  [A CBOR library], [Deterministic CBOR for certificates. To be chosen in v0.3.0: it must produce deterministic encoding, sorted map keys and shortest integers.],
)

The Noise NK handshake is implemented in SRS on these primitives rather than
taken from a little-used Noise package; it must pass the published test
vectors before anything is built on it.

=== Planned Rust stack

Used from series v1.1 (@implementation).

#table(
  columns: (auto, 1fr),
  table.header([*Crate*], [*Use*]),
  [`napi-rs`], [Native module loaded by Bun during the piece-by-piece replacement.],
  [`wasm-bindgen`], [WebAssembly build of the protocol crate for the client.],
  [`opaque-ke`], [OPAQUE, with the same cipher suite and Argon2 settings as the TypeScript side.],
  [`snow`], [Noise.],
  [`ed25519-dalek`, `x25519-dalek`], [Signatures and key agreement where used outside `snow`.],
  [`chacha20poly1305`, `hkdf`, `hmac`, `sha2`], [RustCrypto primitives.],
  [`zeroize`], [Wipes secrets from memory after use.],
  [`ciborium`], [CBOR; deterministic output to be confirmed against the certificate fixtures.],
  [`axum` on `hyper`], [HTTP, when Rust takes over the socket.],
  [`sqlx` or `sea-query`], [Database access and SQL building for several dialects (v1.2). To be chosen in v1.2.0.],
  [Turso's Rust crate], [SQLite-compatible storage, matching the TypeScript side. To be confirmed in v1.1.5.],
)

=== Library policy

- Every cryptographic primitive comes from a vetted, maintained library. SRS
  never implements a primitive itself; it implements only the protocol joins
  this book specifies.
- Adding or replacing a cryptographic or protocol library needs a decision row
  (@decisions).
- Any other new dependency must be used, maintained, and pass `bun audit`.
  Unused dependencies are removed.
- `bun.lock` is committed and CI installs with `--frozen-lockfile`.
