= Decision log <decisions>

Status: *Implemented* for the log itself.

Add a row before changing a design rule. When a rule is replaced, mark its row
*Superseded* and name the row that replaces it.

#table(
  columns: (auto, 1fr, 1fr),
  table.header([*ID*], [*Decision*], [*Why*]),
  [D001], [JSON Schema is the source of truth], [One declarative input generates the database and the API],
  [D002], [Generated artifacts are never hand-edited], [Regeneration must be safe and repeatable],
  [D003], [UUIDv7 blobs, formatted at the API boundary], [Sortable ids without exposing storage details],
  [D004], [Every table has `id`, `updated_at` and `owner`], [Uniform identity, ordering and authorization],
  [D005], [Exposed rows carry `visibility`; the default is private], [Secure defaults without per-resource code],
  [D006], [Ownership is user-only; groups receive shares], [A signature must map to one accountable user],
  [D007], [`x-exposed: false` removes a resource from every surface], [Hiding is a build-time guarantee, not a filter],
  [D008], [Reads use generated views; writes use base tables], [Embedded relations without request-time joins],
  [D009], [Authorization is declarative and central], [Avoids divergent per-handler checks],
  [D010], [Authored views are read-only and inherit the base read policy], [A projection must not widen access],
  [D011], [`x-view: true` identifies a view; `x-source` alone does not], [Unknown keywords are ignored, so intent must be explicit],
  [D012], [Authored views name direct relations and follow only to-one column paths], [A view column cannot hold a to-many scalar],
  [D013], [OPAQUE handles passwords], [Passwords never leave the client and cannot be guessed offline from the database],
  [D014], [Persistent account state lives in the hidden `key` table; channel state lives in memory], [Logins survive restarts; transport keys are never written to disk],
  [D015], [Migrations are deterministic and applied migrations are immutable], [Reviewable, replayable database changes],
  [D016], [The HTTP surface is generated JSON:API], [No per-resource controller code],
  [D017], [Hidden rows return `404`, not `403`], [Do not reveal that an unreadable row exists],
  [D018], [The design book decides rules; `doc/` describes what is built; TypeDoc describes the TS API], [Each source documents one thing],
  [D019], [External identity providers are accepted as OIDC bearer tokens in the bearer transport only], [Provider tokens are bearer tokens and cannot be signed; they must not weaken the Noise transport],
  [D020], [Backups run inside the server; restore runs offline], [The database file is locked by the process that opens it],
  [D021], [One server process per database], [The file lock makes a second process impossible],
  [D022], [The default transport is a Noise NK channel authenticated by a pinned server key], [Secure on networks without TLS; standard, analysed handshake],
  [D023], [Every request after login is signed with a session key, then encrypted], [Accountability to third parties, which channel encryption alone cannot give],
  [D024], [Each user has an Ed25519 identity key wrapped under the OPAQUE export key; it certifies session keys], [The server cannot forge a user's signatures, and any device with the password can sign],
  [D025], [Login is bound to the channel by an HMAC of the handshake hash under the OPAQUE session key], [A login cannot be relayed through another channel, and a session key cannot be swapped in transit],
  [D026], [Strict mode: under `noise`, nothing but the handshake, key bundle and health routes is served in the clear], [No downgrade to an unencrypted route],
  [D027], [Retired and revoked keys, certificates and retained signatures are never deleted; users that own keys are not deleted], [Retained signatures must stay verifiable],
  [D028], [The protocol joins are specified in this book before code is written, and the code follows the book], [The joins between standard parts are where protocol bugs occur],
  [D029], [SRS is completed and stabilised in TypeScript first; that implementation is the reference], [Settle the protocol and API where change is cheap, and give Rust something to be checked against],
  [D030], [Rust replaces the server one module at a time, inside the Bun process through Node-API, each behind an `SRS_IMPL_<PIECE>` switch], [The database lock rules out two processes; SRS keeps working at every step and a faulty piece can be switched back],
  [D031], [Every replaceable piece has a language-neutral conformance suite that both implementations must pass, plus differential tests while both exist], [Equivalence is proved by tests, not assumed],
  [D032], [The wire format is frozen and versioned before Rust replaces any protocol code], [Two implementations can only agree on a fixed target],
  [D033], [The client's API stays TypeScript; its cryptography may use the WebAssembly build of the Rust protocol crate], [Clients must be TypeScript or WebAssembly; one protocol implementation on both sides removes a class of mismatch],
  [D034], [Pluggable databases are added only after Rust owns storage], [The dialect layer is written once, in the final implementation],
  [D035], [Rust pieces use vetted libraries for every primitive: `opaque-ke`, `snow`, `ed25519-dalek`, RustCrypto], [Rust is chosen because these exist; no primitive is written by hand],
)
