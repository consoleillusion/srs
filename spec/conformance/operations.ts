import
  { bytesToHex
  , decodeCertificate
  , encodeCertificate
  , hexToBytes
  , lengthPrefixed
  , u64be
  } from '../../src/protocol/encoding.ts'
import { checkFingerprint, checkTransition, serverKeysFromSecret, srsPrologue, transitionMessage } from '../../src/protocol/server-keys.ts'
import { encryptWithNonce, initiator, keyPairFromPrivate, responder } from '../../src/protocol/noise.ts'
import { decodeRequest, decodeResponse, encodeRequest, encodeResponse, open, parseEnvelope, seal } from '../../src/protocol/envelope.ts'
import
  { loginBinder
  , registrationProofMessage
  , requestMessage
  , signCertificate
  , unwrapIdentity
  , verifyCertificate
  , wrapIdentity
  } from '../../src/protocol/accounts.ts'
import { ed25519PublicKey, ed25519Sign, ed25519Verify, signingMessage } from '../../src/client/crypto.ts'
import type { Operation } from './runner.ts'
import { engineOperations } from './engine-operations.ts'
import { httpOperations } from './http-operations.ts'

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
    , 'envelope.encode-request': (input:
      { method: string, path: string, headers: [string, string][], body: string, signature: string }) =>
      bytesToHex(encodeRequest(
        { method: input.method, path: input.path, headers: input.headers
        , body: hexToBytes(input.body), signature: hexToBytes(input.signature) }))
  , 'envelope.encode-response': (input:
      { status: number, headers: [string, string][], body: string, signature: string }) =>
      bytesToHex(encodeResponse(
        { status: input.status, headers: input.headers, body: hexToBytes(input.body), signature: hexToBytes(input.signature) }))
  , 'envelope.seal': (input: { key: string, sid: string, n: string, plaintext: string }) =>
      bytesToHex(seal(hexToBytes(input.key), hexToBytes(input.sid), BigInt(input.n), hexToBytes(input.plaintext)))
  , 'envelope.decode-request': (input: { plaintext: string }) => {
      const request = decodeRequest(hexToBytes(input.plaintext))
      return { method: request.method, path: request.path, headers: request.headers }
    }
    , 'accounts.registration-proof': (input: { h: string, userId: string, username: string, identitySeed: string }) => {
      const seed = hexToBytes(input.identitySeed)
      const message =
        registrationProofMessage(hexToBytes(input.h), hexToBytes(input.userId), input.username, ed25519PublicKey(seed))
      return { message: bytesToHex(message), signature: bytesToHex(ed25519Sign(message, seed)) }
    }
  , 'accounts.binder': (input: { sessionKey: string, h: string, sid: string }) =>
      bytesToHex(loginBinder(hexToBytes(input.sessionKey), hexToBytes(input.h), hexToBytes(input.sid)))
  , 'accounts.wrap': (input: { exportKey: string, userId: string, identitySeed: string, nonce: string }) => {
      const seed = hexToBytes(input.identitySeed)
      return bytesToHex(wrapIdentity(
        { exportKey: hexToBytes(input.exportKey), userId: hexToBytes(input.userId)
        , identityPublic: ed25519PublicKey(seed), identityPrivate: seed, nonce: hexToBytes(input.nonce) }))
    }
  , 'accounts.unwrap': (input: { exportKey: string, userId: string, identityPublic: string, wrapped: string }) =>
      bytesToHex(unwrapIdentity(
        { exportKey: hexToBytes(input.exportKey), userId: hexToBytes(input.userId)
        , identityPublic: hexToBytes(input.identityPublic), wrapped: hexToBytes(input.wrapped) }))
  , 'accounts.sign-certificate': (input:
      { identitySeed: string, userId: string, loginId: string, sid: string, h: string
      , sessionPublic: string, issuedAt: number, expiresAt: number }) => {
      const signed = signCertificate(hexToBytes(input.identitySeed),
        { userId: hexToBytes(input.userId), loginId: hexToBytes(input.loginId), sid: hexToBytes(input.sid)
        , h: hexToBytes(input.h), sessionPublic: hexToBytes(input.sessionPublic)
        , issuedAt: input.issuedAt, expiresAt: input.expiresAt })
      return { certificate: bytesToHex(signed.certificate), signature: bytesToHex(signed.signature) }
    }
  , 'accounts.sign-request': (input:
      { sessionSeed: string, h: string, sid: string, n: string, method: string, path: string
      , contentType: string, body: string }) => {
      const message = requestMessage(
        { h: hexToBytes(input.h), sid: hexToBytes(input.sid), n: BigInt(input.n), method: input.method
        , path: input.path, contentType: input.contentType, body: hexToBytes(input.body) })
      return { message: bytesToHex(message), signature: bytesToHex(ed25519Sign(message, hexToBytes(input.sessionSeed))) }
    }
    , 'server-keys.transition-message': (input:
      { previousX25519: string, previousEd25519: string, nextX25519: string, nextEd25519: string, stopAt: number }) =>
      bytesToHex(transitionMessage(
        { x25519: hexToBytes(input.previousX25519), ed25519: hexToBytes(input.previousEd25519) }
        , { x25519: hexToBytes(input.nextX25519), ed25519: hexToBytes(input.nextEd25519) }, input.stopAt))
  , 'server-keys.transition-check': (input:
      { previousX25519: string, previousEd25519: string, nextX25519: string, nextEd25519: string, stopAt: number, signature: string }) => {
      checkTransition(
        { x25519: hexToBytes(input.previousX25519), ed25519: hexToBytes(input.previousEd25519) }
        , { x25519: hexToBytes(input.nextX25519), ed25519: hexToBytes(input.nextEd25519) }
        , input.stopAt, hexToBytes(input.signature))
      return true
    }
    , 'envelope.open': (input: { key: string, envelope: string }) => {
      const parsed = parseEnvelope(hexToBytes(input.envelope))
      return bytesToHex(open(hexToBytes(input.key), parsed.sid, parsed.n, parsed.ciphertext))
    }
  , 'envelope.decode-response': (input: { plaintext: string }) => {
      const response = decodeResponse(hexToBytes(input.plaintext))
      return { status: response.status, headers: response.headers }
    }
  , 'accounts.verify-certificate': (input: { identityPublic: string, certificate: string, signature: string }) =>
      verifyCertificate(hexToBytes(input.identityPublic), hexToBytes(input.certificate), hexToBytes(input.signature))
  , 'accounts.verify-request': (input:
      { sessionPublic: string, h: string, sid: string, n: string, method: string, path: string
      , contentType: string, body: string, signature: string }) =>
      ed25519Verify(
        hexToBytes(input.signature)
        , requestMessage(
            { h: hexToBytes(input.h), sid: hexToBytes(input.sid), n: BigInt(input.n), method: input.method
            , path: input.path, contentType: input.contentType, body: hexToBytes(input.body) })
        , hexToBytes(input.sessionPublic))
  , 'bearer.signing-message': (input: { method: string, path: string, sessionId: string, timestamp: string, nonce: string, body: string }) =>
      bytesToHex(signingMessage({ ...input, body: hexToBytes(input.body) }))
  , 'bearer.sign': (input: { seed: string, message: string }) =>
      bytesToHex(ed25519Sign(hexToBytes(input.message), hexToBytes(input.seed)))
  , ...engineOperations
  , ...httpOperations
  }
