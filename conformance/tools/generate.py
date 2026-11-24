"""Independent reference implementation that writes the conformance fixtures.

It is deliberately written separately from the TypeScript code, in Python, so
the fixtures check each implementation against a second one rather than
against itself. Run from the repository root:

    python3 conformance/tools/generate.py

Every fixture is deterministic: no randomness, no clock.
"""
import json
import os
import struct

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


if __name__ == '__main__':
    encoding()
