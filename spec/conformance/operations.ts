import
  { bytesToHex
  , decodeCertificate
  , encodeCertificate
  , hexToBytes
  , lengthPrefixed
  , u64be
  } from '../../src/protocol/encoding.ts'
import { checkFingerprint, serverKeysFromSecret, srsPrologue } from '../../src/protocol/server-keys.ts'
import { encryptWithNonce, initiator, keyPairFromPrivate, responder } from '../../src/protocol/noise.ts'
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
    , 'noise.nk.run': (input:
      { prologue: string, initiatorEphemeral: string, responderStatic: string
      , responderEphemeral: string, payloads: string[] }) => {
      const prologue = hexToBytes(input.prologue)
      const staticKey = keyPairFromPrivate(hexToBytes(input.responderStatic))
      const client = initiator(
        { prologue, responderStatic: staticKey.publicKey
        , ephemeral: keyPairFromPrivate(hexToBytes(input.initiatorEphemeral)) })
      const server = responder(
        { prologue, staticKey, ephemeral: keyPairFromPrivate(hexToBytes(input.responderEphemeral)) })
      const payloads = input.payloads.map(hexToBytes)
      const m1 = client.writeMessage1(payloads[0]!)
      if (bytesToHex(server.readMessage1(m1)) !== input.payloads[0]) throw new Error('message 1 payload')
      const written = server.writeMessage2(payloads[1]!)
      const read = client.readMessage2(written.message)
      if (bytesToHex(read.payload) !== input.payloads[1]) throw new Error('message 2 payload')
      if (bytesToHex(read.result.handshakeHash) !== bytesToHex(written.result.handshakeHash))
        throw new Error('handshake hashes differ')
      const n = [0n, 0n]
      const transport = payloads.slice(2).map((payload, index) => {
        const side = index % 2
        const key = side === 0 ? read.result.initiatorToResponder : read.result.responderToInitiator
        return bytesToHex(encryptWithNonce(key, n[side]!++, new Uint8Array(0), payload))
      })
      return (
        { messages: [bytesToHex(m1), bytesToHex(written.message), ...transport]
        , handshakeHash: bytesToHex(read.result.handshakeHash)
        })
    }
  , 'noise.srs-prologue': (input: { x25519: string, ed25519: string }) =>
      bytesToHex(srsPrologue({ x25519: hexToBytes(input.x25519), ed25519: hexToBytes(input.ed25519) }))
  , 'noise.nk.initiator-read': (input:
      { prologue: string, initiatorEphemeral: string, responderStaticPublic: string, message2: string }) => {
      const client = initiator(
        { prologue: hexToBytes(input.prologue), responderStatic: hexToBytes(input.responderStaticPublic)
        , ephemeral: keyPairFromPrivate(hexToBytes(input.initiatorEphemeral)) })
      client.writeMessage1(new Uint8Array(0))
      return bytesToHex(client.readMessage2(hexToBytes(input.message2)).payload)
    }
  , 'noise.nk.responder-read': (input: { prologue: string, responderStatic: string, message1: string }) =>
      bytesToHex(
        responder({ prologue: hexToBytes(input.prologue), staticKey: keyPairFromPrivate(hexToBytes(input.responderStatic)) })
          .readMessage1(hexToBytes(input.message1)))
  , 'noise.encrypt': (input: { key: string, nonce: string, ad: string, plaintext: string }) =>
      bytesToHex(encryptWithNonce(hexToBytes(input.key), BigInt(input.nonce), hexToBytes(input.ad), hexToBytes(input.plaintext)))
  }
