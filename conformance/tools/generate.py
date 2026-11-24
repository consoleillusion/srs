"""Independent reference implementation that writes the conformance fixtures.

It is deliberately written separately from the TypeScript code, in Python, so
the fixtures check each implementation against a second one rather than
against itself. Run from the repository root:

    python3 conformance/tools/generate.py

Every fixture is deterministic: no randomness, no clock.
"""
import base64
import hashlib
import hmac
import json
import os
import struct

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, x25519
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
import nacl.bindings

ROOT = os.path.join(os.path.dirname(__file__), '..')


def write(suite, name, case):
    path = os.path.join(ROOT, suite, name + '.json')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(case, f, indent=2)
        f.write('\n')


def h(b):
    return b.hex()


def seq(n, start=0):
    """n bytes counting up from start (mod 256); readable, deterministic test values."""
    return bytes((start + i) % 256 for i in range(n))


# ── encoding ──────────────────────────────────────────────────────────────

def length_prefixed(*fields):
    return b''.join(struct.pack('>I', len(f)) + f for f in fields)


def certificate(user_id, login_id, sid, hh, session_public, issued_at, expires_at):
    return (b'srs-cert-v1' + user_id + login_id + sid + hh + session_public
            + struct.pack('>Q', issued_at) + struct.pack('>Q', expires_at))


def encoding():
    s = 'protocol/encoding'
    for name, fields in [
        ('length-prefixed-empty-list', []),
        ('length-prefixed-empty-field', [b'']),
        ('length-prefixed-several', [b'srs-req-v1', seq(3), b'GET', b'/article?sort=-id']),
        ('length-prefixed-utf8', ['ā/é'.encode()]),
    ]:
        write(s, name, {
            'description': 'Fields joined, each prefixed with its 4-byte big-endian length',
            'operation': 'encoding.length-prefixed',
            'input': {'fields': [h(f) for f in fields]},
            'output': h(length_prefixed(*fields)),
        })

    for name, value in [('u64-zero', 0), ('u64-max-safe', 2**53 - 1), ('u64-time', 1764000000000)]:
        write(s, name, {
            'description': 'An unsigned integer as 8 big-endian bytes',
            'operation': 'encoding.u64be',
            'input': {'value': str(value)},
            'output': h(struct.pack('>Q', value)),
        })
    for name, value in [('u64-negative', -1), ('u64-too-large', 2**64)]:
        write(s, name, {
            'description': 'A value outside the 64-bit unsigned range is refused',
            'operation': 'encoding.u64be',
            'input': {'value': str(value)},
            'error': 'out-of-range',
        })

    fields = {
        'userId': seq(16, 0x10), 'loginId': seq(16, 0x20), 'sid': seq(16, 0x30),
        'h': seq(32, 0x40), 'sessionPublic': seq(32, 0x60),
        'issuedAt': 1764000000000, 'expiresAt': 1764086400000,
    }
    as_input = {k: (h(v) if isinstance(v, bytes) else v) for k, v in fields.items()}
    encoded = certificate(*fields.values())
    write(s, 'certificate', {
        'description': 'A session certificate in its fixed layout',
        'operation': 'encoding.certificate',
        'input': as_input,
        'output': h(encoded),
    })
    write(s, 'certificate-decode', {
        'description': 'Decoding returns the same fields',
        'operation': 'encoding.certificate.decode',
        'input': {'bytes': h(encoded)},
        'output': as_input,
    })
    write(s, 'certificate-short-sid', {
        'description': 'A field of the wrong length is refused',
        'operation': 'encoding.certificate',
        'input': {**as_input, 'sid': h(seq(15))},
        'error': 'invalid-length',
    })
    write(s, 'certificate-expired-before-issued', {
        'description': 'expiresAt must be after issuedAt',
        'operation': 'encoding.certificate',
        'input': {**as_input, 'expiresAt': fields['issuedAt']},
        'error': 'invalid-certificate',
    })
    write(s, 'certificate-decode-wrong-tag', {
        'description': 'A different version tag is refused',
        'operation': 'encoding.certificate.decode',
        'input': {'bytes': h(b'srs-cert-v2' + encoded[11:])},
        'error': 'invalid-certificate',
    })
    write(s, 'certificate-decode-truncated', {
        'description': 'A truncated certificate is refused',
        'operation': 'encoding.certificate.decode',
        'input': {'bytes': h(encoded[:-1])},
        'error': 'invalid-certificate',
    })


# ── server keys ───────────────────────────────────────────────────────────

RAW = serialization.Encoding.Raw, serialization.PublicFormat.Raw


def x25519_public(private):
    return x25519.X25519PrivateKey.from_private_bytes(private).public_key().public_bytes(*RAW)


def ed25519_public(seed):
    return ed25519.Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(*RAW)


def fingerprint(x_pub, ed_pub):
    digest = hashlib.sha256(b'srs-keys-v1' + x_pub + ed_pub).digest()
    return 'srs1:' + base64.b32encode(digest).decode().lower().rstrip('=')


def server_keys():
    s = 'protocol/server-keys'
    for name, secret in [('derive-a', seq(64, 1)), ('derive-b', seq(64, 0x80))]:
        x_pub, ed_pub = x25519_public(secret[:32]), ed25519_public(secret[32:])
        write(s, name, {
            'description': 'Public keys and fingerprint derived from the 64-byte bundle secret',
            'operation': 'server-keys.derive',
            'input': {'secret': h(secret)},
            'output': {'x25519': h(x_pub), 'ed25519': h(ed_pub), 'fingerprint': fingerprint(x_pub, ed_pub)},
        })
    x_pub, ed_pub = x25519_public(seq(32, 1)), ed25519_public(seq(32, 33))
    write(s, 'check-match', {
        'description': 'A bundle matching the pinned fingerprint is accepted',
        'operation': 'server-keys.check',
        'input': {'x25519': h(x_pub), 'ed25519': h(ed_pub), 'pinned': fingerprint(x_pub, ed_pub)},
        'output': True,
    })
    write(s, 'check-swapped-signing-key', {
        'description': 'A bundle whose signing key differs from the pinned one is refused',
        'operation': 'server-keys.check',
        'input': {'x25519': h(x_pub), 'ed25519': h(ed25519_public(seq(32, 99))), 'pinned': fingerprint(x_pub, ed_pub)},
        'error': 'fingerprint-mismatch',
    })
    write(s, 'derive-short-secret', {
        'description': 'A secret that is not 64 bytes is refused',
        'operation': 'server-keys.derive',
        'input': {'secret': h(seq(63))},
        'error': 'invalid-length',
    })


# ── Noise NK (independent implementation from the Noise specification) ───

NOISE_NAME = b'Noise_NK_25519_ChaChaPoly_BLAKE2s'


def blake2s(data):
    return hashlib.blake2s(data).digest()


def noise_hkdf(ck, ikm):
    temp = hmac.new(ck, ikm, hashlib.blake2s).digest()
    out1 = hmac.new(temp, b'\x01', hashlib.blake2s).digest()
    out2 = hmac.new(temp, out1 + b'\x02', hashlib.blake2s).digest()
    return out1, out2


def chacha_nonce(n):
    return b'\x00' * 4 + struct.pack('<Q', n)


def x25519_dh(private, public):
    return x25519.X25519PrivateKey.from_private_bytes(private).exchange(
        x25519.X25519PublicKey.from_public_bytes(public))


class Symmetric:
    def __init__(self):
        # A protocol name longer than the hash length is hashed, not padded.
        self.h = NOISE_NAME + b'\x00' * (32 - len(NOISE_NAME)) if len(NOISE_NAME) <= 32 else blake2s(NOISE_NAME)
        self.ck = self.h
        self.k = None
        self.n = 0

    def mix_hash(self, data):
        self.h = blake2s(self.h + data)

    def mix_key(self, ikm):
        self.ck, self.k = noise_hkdf(self.ck, ikm)
        self.n = 0

    def encrypt_and_hash(self, plaintext):
        c = ChaCha20Poly1305(self.k).encrypt(chacha_nonce(self.n), plaintext, self.h)
        self.n += 1
        self.mix_hash(c)
        return c

    def decrypt_and_hash(self, c):
        p = ChaCha20Poly1305(self.k).decrypt(chacha_nonce(self.n), c, self.h)
        self.n += 1
        self.mix_hash(c)
        return p


def noise_nk(prologue, init_e, resp_s, resp_e, payloads):
    """Run both sides of NK; return message bytes, handshake hash and transport keys."""
    rs_pub = x25519_public(resp_s)
    i, r = Symmetric(), Symmetric()
    for st in (i, r):
        st.mix_hash(prologue)
        st.mix_hash(rs_pub)
    # -> e, es
    e_pub = x25519_public(init_e)
    i.mix_hash(e_pub); i.mix_key(x25519_dh(init_e, rs_pub))
    m1 = e_pub + i.encrypt_and_hash(payloads[0])
    r.mix_hash(m1[:32]); r.mix_key(x25519_dh(resp_s, m1[:32]))
    assert r.decrypt_and_hash(m1[32:]) == payloads[0]
    # <- e, ee
    re_pub = x25519_public(resp_e)
    r.mix_hash(re_pub); r.mix_key(x25519_dh(resp_e, e_pub))
    m2 = re_pub + r.encrypt_and_hash(payloads[1])
    i.mix_hash(m2[:32]); i.mix_key(x25519_dh(init_e, m2[:32]))
    assert i.decrypt_and_hash(m2[32:]) == payloads[1]
    assert i.h == r.h
    c1, c2 = noise_hkdf(i.ck, b'')
    messages = [m1, m2]
    n = [0, 0]
    for index, payload in enumerate(payloads[2:]):
        side = index % 2
        key = (c1, c2)[side]
        messages.append(ChaCha20Poly1305(key).encrypt(chacha_nonce(n[side]), payload, b''))
        n[side] += 1
    return messages, i.h, c1, c2


def noise_vector_case(v):
    payloads = [bytes.fromhex(m['payload']) for m in v['messages']]
    messages, hh, _, _ = noise_nk(bytes.fromhex(v['init_prologue']), bytes.fromhex(v['init_ephemeral']),
                                  bytes.fromhex(v['resp_static']), bytes.fromhex(v['resp_ephemeral']), payloads)
    for m, expected in zip(messages, v['messages']):
        assert m.hex() == expected['ciphertext'], 'reference Noise disagrees with ' + v['source']
    if 'handshake_hash' in v:
        assert hh.hex() == v['handshake_hash']
    return {
        'prologue': v['init_prologue'], 'initiatorEphemeral': v['init_ephemeral'],
        'responderStatic': v['resp_static'], 'responderEphemeral': v['resp_ephemeral'],
        'payloads': [m['payload'] for m in v['messages']],
    }, {
        'messages': [m.hex() for m in messages], 'handshakeHash': hh.hex(),
    }


def noise():
    s = 'protocol/noise'
    with open(os.path.join(os.path.dirname(__file__), 'vectors', 'noise-nk.json')) as f:
        vectors = json.load(f)['vectors']
    for v in vectors:
        inp, out = noise_vector_case(v)
        write(s, 'nk-published-' + v['source'], {
            'description': 'Published Noise_NK_25519_ChaChaPoly_BLAKE2s vector from ' + v['source'],
            'operation': 'noise.nk.run',
            'input': inp,
            'output': out,
        })

    # The SRS handshake: prologue binds the server key fingerprint, message 1 is
    # empty, message 2 carries the 16-byte channel id.
    x_priv, ed_seed = seq(32, 7), seq(32, 39)
    digest = hashlib.sha256(b'srs-keys-v1' + x25519_public(x_priv) + ed25519_public(ed_seed)).digest()
    prologue = b'srs-noise-v1' + digest
    sid = seq(16, 0xa0)
    payloads = [b'', sid, b'first request', b'first response']
    messages, hh, c1, c2 = noise_nk(prologue, seq(32, 71), x_priv, seq(32, 103), payloads)
    write(s, 'srs-handshake', {
        'description': 'The SRS handshake: prologue is srs-noise-v1 and the fingerprint digest; message 2 carries the channel id',
        'operation': 'noise.nk.run',
        'input': {'prologue': h(prologue), 'initiatorEphemeral': h(seq(32, 71)), 'responderStatic': h(x_priv),
                  'responderEphemeral': h(seq(32, 103)), 'payloads': [h(p) for p in payloads]},
        'output': {'messages': [h(m) for m in messages], 'handshakeHash': h(hh)},
    })
    write(s, 'srs-prologue', {
        'description': 'The SRS prologue for a server key bundle',
        'operation': 'noise.srs-prologue',
        'input': {'x25519': h(x25519_public(x_priv)), 'ed25519': h(ed25519_public(ed_seed))},
        'output': h(prologue),
    })
    tampered = bytearray(messages[1]); tampered[-1] ^= 1
    write(s, 'srs-tampered-message-2', {
        'description': 'A modified message 2 fails authentication at the initiator',
        'operation': 'noise.nk.initiator-read',
        'input': {'prologue': h(prologue), 'initiatorEphemeral': h(seq(32, 71)),
                  'responderStaticPublic': h(x25519_public(x_priv)), 'message2': h(bytes(tampered))},
        'error': 'decrypt-failed',
    })
    other_prologue = b'srs-noise-v1' + bytes(32)
    write(s, 'srs-wrong-prologue', {
        'description': 'A responder with a different prologue cannot read message 1',
        'operation': 'noise.nk.responder-read',
        'input': {'prologue': h(other_prologue), 'responderStatic': h(x_priv), 'message1': h(messages[0])},
        'error': 'decrypt-failed',
    })
    write(s, 'srs-low-order-key', {
        'description': 'A low-order ephemeral key in message 1 is refused',
        'operation': 'noise.nk.responder-read',
        'input': {'prologue': h(prologue), 'responderStatic': h(x_priv), 'message1': h(bytes(32) + bytes(16))},
        'error': 'invalid-key',
    })
    write(s, 'srs-short-message-1', {
        'description': 'A message 1 shorter than a key and a tag is refused',
        'operation': 'noise.nk.responder-read',
        'input': {'prologue': h(prologue), 'responderStatic': h(x_priv), 'message1': h(seq(47))},
        'error': 'invalid-length',
    })
    write(s, 'transport-explicit-nonce', {
        'description': 'Transport encryption with an explicit nonce and associated data, as the envelope uses it',
        'operation': 'noise.encrypt',
        'input': {'key': h(c1), 'nonce': '5', 'ad': h(b'SRS1' + sid + struct.pack('>Q', 5)), 'plaintext': h(b'GET /article')},
        'output': h(ChaCha20Poly1305(c1).encrypt(chacha_nonce(5), b'GET /article', b'SRS1' + sid + struct.pack('>Q', 5))),
    })


# ── envelope ──────────────────────────────────────────────────────────────

def envelope_ad(sid, n):
    return b'SRS1' + sid + struct.pack('>Q', n)


def encode_headers(pairs):
    return length_prefixed(*[x for name, value in pairs for x in (name.lower().encode(), value.encode())])


def envelope():
    s = 'protocol/envelope'
    key, sid = seq(32, 9), seq(16, 0xb0)
    request = length_prefixed(b'POST', b'/article?include=tag',
                              encode_headers([('content-type', 'application/vnd.api+json'), ('accept', 'application/vnd.api+json')]),
                              b'{"data":{"type":"article"}}', seq(64, 200))
    write(s, 'request-encoding', {
        'description': 'A request as length-prefixed method, path, headers, body and signature',
        'operation': 'envelope.encode-request',
        'input': {'method': 'POST', 'path': '/article?include=tag',
                  'headers': [['content-type', 'application/vnd.api+json'], ['accept', 'application/vnd.api+json']],
                  'body': h(b'{"data":{"type":"article"}}'), 'signature': h(seq(64, 200))},
        'output': h(request),
    })
    response = length_prefixed(b'201', encode_headers([('location', '/article/1')]), b'{}', b'')
    write(s, 'response-encoding', {
        'description': 'A response as length-prefixed status, headers, body and signature',
        'operation': 'envelope.encode-response',
        'input': {'status': 201, 'headers': [['location', '/article/1']], 'body': h(b'{}'), 'signature': ''},
        'output': h(response),
    })
    for n in (0, 7, 2**40):
        ad = envelope_ad(sid, n)
        write(s, f'seal-{n}', {
            'description': 'An envelope: magic, channel id, counter, then the ciphertext under that counter',
            'operation': 'envelope.seal',
            'input': {'key': h(key), 'sid': h(sid), 'n': str(n), 'plaintext': h(request)},
            'output': h(ad + ChaCha20Poly1305(key).encrypt(chacha_nonce(n), request, ad)),
        })
    write(s, 'decode-request-odd-headers', {
        'description': 'A header name without a value is refused',
        'operation': 'envelope.decode-request',
        'input': {'plaintext': h(length_prefixed(b'GET', b'/tag', length_prefixed(b'accept'), b'', b''))},
        'error': 'invalid-encoding',
    })
    write(s, 'decode-request-bad-signature-length', {
        'description': 'A signature that is neither empty nor 64 bytes is refused',
        'operation': 'envelope.decode-request',
        'input': {'plaintext': h(length_prefixed(b'GET', b'/tag', b'', b'', seq(63)))},
        'error': 'invalid-encoding',
    })
    write(s, 'decode-request-relative-path', {
        'description': 'A path that does not start with / is refused',
        'operation': 'envelope.decode-request',
        'input': {'plaintext': h(length_prefixed(b'GET', b'tag', b'', b'', b''))},
        'error': 'invalid-encoding',
    })

# ── accounts ──────────────────────────────────────────────────────────────

def ed25519_sign(seed, message):
    return ed25519.Ed25519PrivateKey.from_private_bytes(seed).sign(message)


def accounts():
    s = 'protocol/accounts'
    hh, sid, user_id = seq(32, 0x11), seq(16, 0x22), seq(16, 0x33)
    identity_seed = seq(32, 0x44)
    identity_public = ed25519_public(identity_seed)

    proof = length_prefixed(b'srs-register-v1', hh, user_id, b'alice', identity_public)
    write(s, 'registration-proof', {
        'description': 'The registration proof message and its identity-key signature',
        'operation': 'accounts.registration-proof',
        'input': {'h': h(hh), 'userId': h(user_id), 'username': 'alice', 'identitySeed': h(identity_seed)},
        'output': {'message': h(proof), 'signature': h(ed25519_sign(identity_seed, proof))},
    })

    k = seq(64, 0x55)
    write(s, 'login-binder', {
        'description': 'HMAC-SHA256 of the channel under the OPAQUE session key',
        'operation': 'accounts.binder',
        'input': {'sessionKey': h(k), 'h': h(hh), 'sid': h(sid)},
        'output': h(hmac.new(k, b'srs-bind-v1' + hh + sid, hashlib.sha256).digest()),
    })

    export_key = seq(64, 0x66)
    wrap_key = HKDF(algorithm=SHA256(), length=32, salt=None, info=b'srs-identity-wrap-v1').derive(export_key)
    nonce = seq(24, 0x77)
    wrapped = nonce + nacl.bindings.crypto_aead_xchacha20poly1305_ietf_encrypt(
        identity_seed, user_id + identity_public, nonce, wrap_key)
    case_input = {'exportKey': h(export_key), 'userId': h(user_id), 'identitySeed': h(identity_seed), 'nonce': h(nonce)}
    write(s, 'wrap-identity', {
        'description': 'The identity key wrapped with XChaCha20-Poly1305 under HKDF of the export key',
        'operation': 'accounts.wrap',
        'input': case_input,
        'output': h(wrapped),
    })
    write(s, 'unwrap-identity', {
        'description': 'Unwrapping returns the identity seed',
        'operation': 'accounts.unwrap',
        'input': {'exportKey': h(export_key), 'userId': h(user_id), 'identityPublic': h(identity_public), 'wrapped': h(wrapped)},
        'output': h(identity_seed),
    })
    write(s, 'unwrap-wrong-password', {
        'description': 'A different export key (wrong password) cannot unwrap',
        'operation': 'accounts.unwrap',
        'input': {'exportKey': h(seq(64, 0x67)), 'userId': h(user_id), 'identityPublic': h(identity_public), 'wrapped': h(wrapped)},
        'error': 'unwrap-failed',
    })
    write(s, 'unwrap-other-user', {
        'description': 'A wrapped key moved to another user cannot be unwrapped',
        'operation': 'accounts.unwrap',
        'input': {'exportKey': h(export_key), 'userId': h(seq(16, 0x34)), 'identityPublic': h(identity_public), 'wrapped': h(wrapped)},
        'error': 'unwrap-failed',
    })

    session_seed = seq(32, 0x88)
    cert = certificate(user_id, seq(16, 0x99), sid, hh, ed25519_public(session_seed), 1764000000000, 1764086400000)
    write(s, 'certificate-signature', {
        'description': 'A session certificate signed by the identity key',
        'operation': 'accounts.sign-certificate',
        'input': {'identitySeed': h(identity_seed), 'userId': h(user_id), 'loginId': h(seq(16, 0x99)), 'sid': h(sid),
                  'h': h(hh), 'sessionPublic': h(ed25519_public(session_seed)),
                  'issuedAt': 1764000000000, 'expiresAt': 1764086400000},
        'output': {'certificate': h(cert), 'signature': h(ed25519_sign(identity_seed, cert))},
    })

    body = b'{"data":{"type":"note","attributes":{"text":"hi"}}}'
    message = length_prefixed(b'srs-req-v1', hh, sid, struct.pack('>Q', 3), b'POST', b'/note',
                              b'application/vnd.api+json', hashlib.sha256(body).digest())
    write(s, 'request-signature', {
        'description': 'The signed message of a request and its session-key signature',
        'operation': 'accounts.sign-request',
        'input': {'sessionSeed': h(session_seed), 'h': h(hh), 'sid': h(sid), 'n': '3', 'method': 'POST',
                  'path': '/note', 'contentType': 'application/vnd.api+json', 'body': h(body)},
        'output': {'message': h(message), 'signature': h(ed25519_sign(session_seed, message))},
    })

def rotation():
    s = 'protocol/server-keys'
    old_x, old_seed = seq(32, 1), seq(32, 33)
    new_x, new_seed = seq(32, 65), seq(32, 97)
    old_digest = hashlib.sha256(b'srs-keys-v1' + x25519_public(old_x) + ed25519_public(old_seed)).digest()
    stop_at = 1766592000000
    message = b'srs-rotate-v1' + old_digest + x25519_public(new_x) + ed25519_public(new_seed) + struct.pack('>Q', stop_at)
    signature = ed25519_sign(old_seed, message)
    base = {'previousX25519': h(x25519_public(old_x)), 'previousEd25519': h(ed25519_public(old_seed)),
            'nextX25519': h(x25519_public(new_x)), 'nextEd25519': h(ed25519_public(new_seed)), 'stopAt': stop_at}
    write(s, 'transition-message', {
        'description': 'The key transition statement the old signing key signs',
        'operation': 'server-keys.transition-message',
        'input': base,
        'output': h(message),
    })
    write(s, 'transition-check', {
        'description': 'A transition signed by the previous signing key is accepted',
        'operation': 'server-keys.transition-check',
        'input': {**base, 'signature': h(signature)},
        'output': True,
    })
    write(s, 'transition-forged', {
        'description': 'A transition signed by any other key is refused',
        'operation': 'server-keys.transition-check',
        'input': {**base, 'signature': h(ed25519_sign(seq(32, 5), message))},
        'error': 'invalid-transition',
    })
    write(s, 'transition-later-stop', {
        'description': 'Changing the stop date breaks the signature',
        'operation': 'server-keys.transition-check',
        'input': {**base, 'stopAt': stop_at + 1, 'signature': h(signature)},
        'error': 'invalid-transition',
    })

def failures():
    """Failure cases across Part III that the topic generators above do not cover."""
    s = 'protocol/failures'
    key, sid = seq(32, 9), seq(16, 0xb0)
    plaintext = length_prefixed(b'GET', b'/tag', b'', b'', b'')
    ad = envelope_ad(sid, 1)
    sealed = ad + ChaCha20Poly1305(key).encrypt(chacha_nonce(1), plaintext, ad)
    write(s, 'envelope-open', {
        'description': 'An envelope opens to its plaintext under the right key and counter',
        'operation': 'envelope.open',
        'input': {'key': h(key), 'envelope': h(sealed)},
        'output': h(plaintext),
    })
    tampered = bytearray(sealed); tampered[-1] ^= 1
    write(s, 'envelope-tampered', {
        'description': 'A changed ciphertext fails authentication',
        'operation': 'envelope.open',
        'input': {'key': h(key), 'envelope': h(bytes(tampered))},
        'error': 'decrypt-failed',
    })
    moved = bytearray(sealed); moved[4:20] = seq(16, 0xc0)
    write(s, 'envelope-moved-channel', {
        'description': 'An envelope relabelled with another channel id fails authentication',
        'operation': 'envelope.open',
        'input': {'key': h(key), 'envelope': h(bytes(moved))},
        'error': 'decrypt-failed',
    })
    renumbered = bytearray(sealed); renumbered[27] ^= 1
    write(s, 'envelope-renumbered', {
        'description': 'An envelope with a changed counter fails authentication',
        'operation': 'envelope.open',
        'input': {'key': h(key), 'envelope': h(bytes(renumbered))},
        'error': 'decrypt-failed',
    })
    write(s, 'envelope-bad-magic', {
        'description': 'An envelope that does not start with SRS1 is refused',
        'operation': 'envelope.open',
        'input': {'key': h(key), 'envelope': h(b'SRS2' + sealed[4:])},
        'error': 'invalid-envelope',
    })
    write(s, 'envelope-too-short', {
        'description': 'An envelope shorter than its header and a tag is refused',
        'operation': 'envelope.open',
        'input': {'key': h(key), 'envelope': h(sealed[:43])},
        'error': 'invalid-envelope',
    })
    write(s, 'response-bad-status', {
        'description': 'A response whose status is not three digits from 100 to 599 is refused',
        'operation': 'envelope.decode-response',
        'input': {'plaintext': h(length_prefixed(b'99', b'', b'', b''))},
        'error': 'invalid-encoding',
    })
    write(s, 'response-extra-field', {
        'description': 'A response with a fifth field is refused',
        'operation': 'envelope.decode-response',
        'input': {'plaintext': h(length_prefixed(b'200', b'', b'', b'', b''))},
        'error': 'invalid-encoding',
    })

    identity_seed = seq(32, 0x44)
    hh = seq(32, 0x11)
    cert = certificate(seq(16, 0x33), seq(16, 0x99), sid, hh, ed25519_public(seq(32, 0x88)), 1764000000000, 1764086400000)
    good = ed25519_sign(identity_seed, cert)
    for name, public, signature, valid in [
        ('certificate-verifies', ed25519_public(identity_seed), good, True),
        ('certificate-other-key', ed25519_public(seq(32, 0x45)), good, False),
        ('certificate-altered', ed25519_public(identity_seed), good[:-1] + bytes([good[-1] ^ 1]), False),
    ]:
        write(s, name, {
            'description': 'A certificate signature checked against an identity public key',
            'operation': 'accounts.verify-certificate',
            'input': {'identityPublic': h(public), 'certificate': h(cert), 'signature': h(signature)},
            'output': valid,
        })
    message = length_prefixed(b'srs-req-v1', hh, sid, struct.pack('>Q', 3), b'GET', b'/tag', b'', hashlib.sha256(b'').digest())
    session_seed = seq(32, 0x88)
    for name, n, valid in [('request-signature-verifies', 3, True), ('request-signature-other-counter', 4, False)]:
        write(s, name, {
            'description': 'A request signature only verifies for the counter it was made for',
            'operation': 'accounts.verify-request',
            'input': {'sessionPublic': h(ed25519_public(session_seed)), 'h': h(hh), 'sid': h(sid), 'n': str(n),
                      'method': 'GET', 'path': '/tag', 'contentType': '', 'body': '',
                      'signature': h(ed25519_sign(session_seed, message))},
            'output': valid,
        })


if __name__ == '__main__':
    encoding()
    server_keys()
    noise()
    envelope()
    accounts()
    rotation()
    failures()
