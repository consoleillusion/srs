import
  { bytesToHex
  , decodeCertificate
  , encodeCertificate
  , hexToBytes
  , lengthPrefixed
  , u64be
  } from '../../src/protocol/encoding.ts'
import { checkFingerprint, serverKeysFromSecret } from '../../src/protocol/server-keys.ts'
import type { Operation } from './runner.ts'

type CertificateInput =
  { userId: string, loginId: string, sid: string, h: string, sessionPublic: string
  , issuedAt: number, expiresAt: number
  }

/** The TypeScript implementation of every conformance operation, by name. */
export const operations: Record<string, Operation> =
  { 'encoding.length-prefixed': (input: { fields: string[] }) =>
      bytesToHex(lengthPrefixed(...input.fields.map(hexToBytes)))
  , 'encoding.u64be': (input: { value: string }) =>
      bytesToHex(u64be(BigInt(input.value)))
  , 'encoding.certificate': (input: CertificateInput) =>
      bytesToHex(encodeCertificate(
        { userId: hexToBytes(input.userId), loginId: hexToBytes(input.loginId)
        , sid: hexToBytes(input.sid), h: hexToBytes(input.h)
        , sessionPublic: hexToBytes(input.sessionPublic)
        , issuedAt: input.issuedAt, expiresAt: input.expiresAt
        }))
  , 'encoding.certificate.decode': (input: { bytes: string }) => {
      const cert = decodeCertificate(hexToBytes(input.bytes))
      return (
        { userId: bytesToHex(cert.userId), loginId: bytesToHex(cert.loginId)
        , sid: bytesToHex(cert.sid), h: bytesToHex(cert.h)
        , sessionPublic: bytesToHex(cert.sessionPublic)
        , issuedAt: cert.issuedAt, expiresAt: cert.expiresAt
        })
    }
    , 'server-keys.derive': (input: { secret: string }) => {
      const keys = serverKeysFromSecret(hexToBytes(input.secret))
      return { x25519: bytesToHex(keys.x25519), ed25519: bytesToHex(keys.ed25519), fingerprint: keys.fingerprint }
    }
  , 'server-keys.check': (input: { x25519: string, ed25519: string, pinned: string }) => {
      checkFingerprint({ x25519: hexToBytes(input.x25519), ed25519: hexToBytes(input.ed25519) }, input.pinned)
      return true
    }
  }
