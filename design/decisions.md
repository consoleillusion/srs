# Decision log

Add a row before changing a design rule. Mark a decision **Superseded** rather
than editing history; link the decision that replaced it.

| ID | Decision | Why |
| --- | --- | --- |
| D001 | JSON Schema is the source of truth | One declarative input generates database and API |
| D002 | Generated artifacts are never hand-edited | Regeneration must be safe and repeatable |
| D003 | UUIDv7 blobs, formatted at the API boundary | Sortable IDs without exposing storage details |
| D004 | Every table has `id`, `updated_at` and `owner` | Uniform identity, ordering and authorization |
| D005 | Exposed rows carry `visibility`; defaults are private | Secure defaults without per-resource code |
| D006 | Ownership is user-only; groups receive shares | A signature must map to one accountable user |
| D007 | `x-exposed: false` removes a resource from every surface | Hiding is a build-time guarantee, not a filter |
| D008 | Reads use generated views; writes use base tables | Embedded relations without request-time joins |
| D009 | Authorization is declarative and centralized | Avoids divergent per-handler access checks |
| D010 | Authored views are read-only and inherit base read policy | A projection must not widen access |
| D011 | `x-view: true` identifies a view; `x-source` alone does not | Unknown keywords are ignored, so intent must be explicit |
| D012 | Authored views name direct relations and follow only to-one column paths | A view column cannot represent a to-many scalar projection |
| D013 | OPAQUE handles passwords; Ed25519 handles request signing | No plaintext passwords; optional non-repudiation |
| D014 | Auth state lives in the hidden `key` table | Stateless processes survive restarts and scale horizontally |
| D015 | Migrations are deterministic and applied migrations are immutable | Reviewable, replayable database changes |
| D016 | The HTTP surface is generated JSON:API | No per-resource controller code to maintain |
| D017 | Hidden rows return `404`, not `403` | Do not reveal that an unreadable row exists |
| D018 | Hand-written design docs describe behaviour; TypeDoc describes TS API | Neither source is asked to document the other's surface |
