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


if __name__ == '__main__':
    noise()
    encoding()
    server_keys()
