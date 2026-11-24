/**
 * Check every retained request signature in a database without trusting the
 * server that wrote them (design book, Verifying a retained signature).
 *
 * @module
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { base64UrlToBytes, ed25519Verify } from '../client/crypto.ts'
import { verifyCertificate } from '../protocol/accounts.ts'
import { decodeCertificate, splitLengthPrefixed } from '../protocol/encoding.ts'
import type { RowDatabase } from '../server/database.ts'
import { canonicalUuid } from '../server/uuid.ts'

/** The outcome for one retained signature. */
export type SignatureCheckResult =
  { auditId: string
  , action: string
  , resource: string
  , valid: boolean
  /** Why the check failed, or a note about a valid signature. */
  , reason?: string
  }

const fail = (reason: string) => ({ valid: false, reason })

/** Compare two byte strings. */
const same =
  (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * Check one audit row's signature.
 *
 * @param db - The database.
 * @param row - The audit row: signature, certificate id, signed message and body.
 */
const checkRow =
  async (db: RowDatabase, row: Record<string, unknown>): Promise<{ valid: boolean, reason?: string }> => {
    if (typeof row.signature !== 'string' || typeof row.signed_message !== 'string')
      return fail('signature or signed message missing')
    const certRow =
      await db.get("SELECT `material`, `user_id` FROM `key` WHERE `id` = ? AND `type` = 'certificate'", [row.certificate_id])
    if (!certRow) return fail('certificate not found')
    const stored = JSON.parse(String(certRow.material)) as { certificate: string, signature: string, identityKey: string, acceptedAt: number }
    const certificate = base64UrlToBytes(stored.certificate)
    const cert = decodeCertificate(certificate)

    const identity =
      await db.get(
        "SELECT `jwk`, `user_id`, `revoked_at` FROM `key` WHERE `id` = ? AND `type` = 'identity'"
        , [Buffer.from(stored.identityKey.replaceAll('-', ''), 'hex')])
    if (!identity) return fail('identity key not found')
    if (!(identity.user_id instanceof Uint8Array) || !same(identity.user_id, cert.userId))
      return fail('identity key belongs to another user')
    const identityPublic = base64UrlToBytes(JSON.parse(String(identity.jwk)).x)
    if (!verifyCertificate(identityPublic, certificate, base64UrlToBytes(stored.signature)))
      return fail('certificate signature does not verify')
    if (identity.revoked_at !== null && identity.revoked_at !== undefined
        && Number(identity.revoked_at) <= stored.acceptedAt)
      return fail('certificate accepted after its identity key was revoked')

    const message = base64UrlToBytes(row.signed_message)
    if (!ed25519Verify(base64UrlToBytes(row.signature), message, cert.sessionPublic))
      return fail('request signature does not verify')

    // The signed message ends with the SHA-256 of the body; check the retained body matches.
    const fields = splitLengthPrefixed(message, 8)
    const body = typeof row.body === 'string' ? new TextEncoder().encode(row.body) : new Uint8Array(0)
    if (!same(fields[7]!, sha256(body))) return fail('retained body does not match the signed hash')
    if (!same(fields[1]!, cert.h) || !same(fields[2]!, cert.sid)) return fail('signed message names another channel')

    return identity.revoked_at !== null && identity.revoked_at !== undefined
      ? { valid: true, reason: 'made before its identity key was revoked' }
      : { valid: true }
  }

/**
 * Check every retained signature.
 *
 * @param db - The database.
 * @returns One result per audit row that carries a certificate.
 */
export const verifyRetainedSignatures =
  async (db: RowDatabase): Promise<SignatureCheckResult[]> => {
    const rows =
      await db.all(
        'SELECT `id`, `action`, `resource`, `signature`, `certificate_id`, `signed_message`, `body`'
        + ' FROM `audit_log` WHERE `certificate_id` IS NOT NULL ORDER BY `updated_at`')
    const results: SignatureCheckResult[] = []
    for (const row of rows) {
      let outcome: { valid: boolean, reason?: string }
      try {
        outcome = await checkRow(db, row)
      } catch (error) {
        outcome = fail(`malformed record: ${error instanceof Error ? error.message : String(error)}`)
      }
      results.push({ auditId: canonicalUuid(row.id), action: String(row.action), resource: String(row.resource), ...outcome })
    }
    return results
  }
