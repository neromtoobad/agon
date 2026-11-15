"""Timelock encryption to a drand round, compatible with drand's tlock tools (tlock-js, the Go ``tle`` CLI).

A forecast encrypted this way can't be read by anyone, Agon's server included, until the drand network publishes
the signature for the chosen round. After that anyone can read it, with this module, tlock-js or ``tle``.

It uses drand's "quicknet" network (a new round every 3 seconds, run by the League of Entropy) and the same
construction as tlock: Boneh-Franklin identity-based encryption on BLS12-381, with the round number as the
identity, wrapping the file key of an age file (https://age-encryption.org/v1). Pure Python on top of ``py_ecc``
and ``pycryptodome``, which ``eth-account`` already installs. Encrypting takes about a second.

    ct = encrypt(b"secret", round_at(time.time() + 3600))   # readable in an hour
    decrypt(ct, beacon_signature)                            # once the round is out
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import math
import secrets
import time

from py_ecc.bls.hash_to_curve import hash_to_G1
from py_ecc.bls.point_compression import compress_G1, compress_G2, decompress_G1, decompress_G2
from py_ecc.optimized_bls12_381 import FQ12, G2, curve_order, field_modulus, multiply, pairing
from py_ecc.optimized_bls12_381 import eq as point_eq

# drand quicknet: unchained BLS signatures on G1 (RFC 9380 hashing), public key on G2
CHAIN_HASH = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"
PUBLIC_KEY = bytes.fromhex(
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d"
    "1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a")
GENESIS = 1692803367
PERIOD = 3
DST = b"BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_"
API = "https://api.drand.sh"

AGE_VERSION = "age-encryption.org/v1"
ARMOR_HEAD = "-----BEGIN AGE ENCRYPTED FILE-----"
ARMOR_FOOT = "-----END AGE ENCRYPTED FILE-----"
CHUNK = 64 * 1024


class TimelockError(Exception):
    pass


# ------------------------------------------------------------------ rounds

def round_at(t: float) -> int:
    """The first round published at or after unix time ``t``."""
    return max(1, math.ceil((t - GENESIS) / PERIOD) + 1)


def round_time(r: int) -> int:
    return GENESIS + (r - 1) * PERIOD


def beacon(r: int, *, timeout: float = 20) -> bytes:
    """The drand signature for round ``r`` (48 bytes), checked against quicknet's public key."""
    import httpx
    resp = httpx.get(f"{API}/{CHAIN_HASH}/public/{r}", timeout=timeout, headers={"user-agent": "agon"})
    if resp.status_code != 200:
        raise TimelockError(f"drand has not published round {r} yet (HTTP {resp.status_code})")
    sig = bytes.fromhex(resp.json()["signature"])
    if not verify_beacon(r, sig):
        raise TimelockError(f"drand's signature for round {r} does not verify")
    return sig


def verify_beacon(r: int, sig: bytes) -> bool:
    P = _g1(sig)
    return _fp12_eq(pairing(G2, P), pairing(_g2(PUBLIC_KEY), hash_to_G1(_round_id(r), DST, hashlib.sha256)))


# ------------------------------------------------------------------ IBE (tlock's encOnG2 / decryptOnG2)

def _round_id(r: int) -> bytes:
    return hashlib.sha256(r.to_bytes(8, "big")).digest()


def _g1(b: bytes):
    return decompress_G1(int.from_bytes(b, "big"))


def _g2(b: bytes):
    return decompress_G2((int.from_bytes(b[:48], "big"), int.from_bytes(b[48:], "big")))


def _g2_bytes(p) -> bytes:
    z1, z2 = compress_G2(p)
    return z1.to_bytes(48, "big") + z2.to_bytes(48, "big")


def _fp12_bytes(x) -> bytes:
    """Serialise a GT element the way kyber and tlock-js do.

    py_ecc writes F_p^12 as polynomials in w with w^12 = 2w^6 - 2. The usual tower is F_p2[u]/(u^2+1),
    F_p6 = F_p2[v]/(v^3 - (u+1)), F_p12 = F_p6[w]/(w^2 - v), so v = w^2 and u = w^6 - 1. A tower coefficient
    a + b*u at w^k (k < 6) is therefore (a - b) w^k + b w^(k+6). tlock orders it c1 then c0 (F_p6),
    each c2, c1, c0 (F_p2), each c1, c0 (F_p), big-endian 48 bytes."""
    c = [int(v) % field_modulus for v in x.coeffs]
    out = b""
    for i in (1, 0):
        for j in (2, 1, 0):
            k = i + 2 * j
            b = c[k + 6]
            a = (c[k] + c[k + 6]) % field_modulus
            out += b.to_bytes(48, "big") + a.to_bytes(48, "big")
    return out


def _fp12_eq(x, y) -> bool:
    return all(int(a) % field_modulus == int(b) % field_modulus for a, b in zip(x.coeffs, y.coeffs))


def _h3(sigma: bytes, msg: bytes) -> int:
    base = hashlib.sha256(b"IBE-H3" + sigma + msg).digest()
    for i in range(1, 65535):
        d = bytearray(hashlib.sha256(i.to_bytes(2, "little") + base).digest())
        d[0] >>= 1
        n = int.from_bytes(d, "big")
        if n < curve_order:
            return n
    raise TimelockError("could not derive a scalar")


def _h4(sigma: bytes, n: int) -> bytes:
    return hashlib.sha256(b"IBE-H4" + sigma).digest()[:n]


def _h2(gt, n: int) -> bytes:
    # py_ecc's pairing differs from the one in kyber and noble (which tlock uses) by an exponent of -3: its final
    # exponentiation is the plain (p^12 - 1)/r, and its Miller loop is not conjugated for BLS12-381's negative x.
    # Raising to -3 gives tlock's value, so ciphertexts open in tlock-js and the Go tools.
    return hashlib.sha256(b"IBE-H2" + _fp12_bytes(FQ12.one() / (gt ** 3))).digest()[:n]


def _xor(a: bytes, b: bytes) -> bytes:
    return bytes(x ^ y for x, y in zip(a, b))


def ibe_encrypt(r: int, msg: bytes) -> bytes:
    if len(msg) > 32:
        raise TimelockError("IBE messages are at most 32 bytes")
    q_id = hash_to_G1(_round_id(r), DST, hashlib.sha256)
    g_id = pairing(_g2(PUBLIC_KEY), q_id)
    sigma = secrets.token_bytes(len(msg))
    rr = _h3(sigma, msg)
    U = multiply(G2, rr)
    V = _xor(sigma, _h2(g_id ** rr, len(msg)))
    W = _xor(msg, _h4(sigma, len(msg)))
    return _g2_bytes(U) + V + W


def ibe_decrypt(signature: bytes, body: bytes) -> bytes:
    U_b, rest = body[:96], body[96:]
    n = len(rest) // 2
    V, W = rest[:n], rest[n:]
    U = _g2(U_b)
    sigma = _xor(_h2(pairing(U, _g1(signature)), n), V)
    msg = _xor(_h4(sigma, n), W)
    if not point_eq(multiply(G2, _h3(sigma, msg)), U):
        raise TimelockError("ciphertext check failed: wrong round or a damaged ciphertext")
    return msg


# ------------------------------------------------------------------ age

def _hkdf(key: bytes, salt: bytes, info: bytes, n: int = 32) -> bytes:
    prk = hmac.new(salt or b"\x00" * 32, key, hashlib.sha256).digest()
    out, t, i = b"", b"", 1
    while len(out) < n:
        t = hmac.new(prk, t + info + bytes([i]), hashlib.sha256).digest()
        out += t
        i += 1
    return out[:n]


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.b64decode(s + "=" * (-len(s) % 4))


def _stream(key: bytes, data: bytes, seal: bool) -> bytes:
    from Crypto.Cipher import ChaCha20_Poly1305
    size = CHUNK if seal else CHUNK + 16
    chunks = [data[i:i + size] for i in range(0, len(data), size)] or [b""]
    out = b""
    for n, chunk in enumerate(chunks):
        nonce = n.to_bytes(11, "big") + (b"\x01" if n == len(chunks) - 1 else b"\x00")
        c = ChaCha20_Poly1305.new(key=key, nonce=nonce)
        if seal:
            ct, tag = c.encrypt_and_digest(chunk)
            out += ct + tag
        else:
            try:
                out += c.decrypt_and_verify(chunk[:-16], chunk[-16:])
            except ValueError:
                raise TimelockError("payload failed authentication") from None
    return out


def encrypt(plaintext: bytes, r: int) -> str:
    """Encrypt ``plaintext`` so it opens at drand quicknet round ``r``. Returns an armored age file."""
    file_key = secrets.token_bytes(16)
    body = ibe_encrypt(r, file_key)
    enc = _b64(body)
    header = f"{AGE_VERSION}\n-> tlock {r} {CHAIN_HASH}\n" + "\n".join(enc[i:i + 64] for i in range(0, len(enc), 64)) + "\n---"
    mac = hmac.new(_hkdf(file_key, b"", b"header"), header.encode(), hashlib.sha256).digest()
    nonce = secrets.token_bytes(16)
    payload = nonce + _stream(_hkdf(file_key, nonce, b"payload"), plaintext, True)
    raw = header.encode() + b" " + _b64(mac).encode() + b"\n" + payload
    b = base64.b64encode(raw).decode()
    lines = [b[i:i + 64] for i in range(0, len(b), 64)]
    foot = ("\n" if lines and len(lines[-1]) == 64 else "") + ARMOR_FOOT
    return f"{ARMOR_HEAD}\n" + "\n".join(lines) + f"\n{foot}\n"


def parse(armored: str) -> tuple[int, str]:
    """(round, chain hash) a tlock ciphertext opens at, without decrypting it."""
    raw = _dearmor(armored)
    for line in raw.split(b"\n"):
        if line.startswith(b"-> tlock "):
            parts = line.decode().split(" ")
            return int(parts[2]), parts[3]
    raise TimelockError("not a tlock ciphertext")


def _dearmor(armored: str) -> bytes:
    s = armored.strip()
    if not (s.startswith(ARMOR_HEAD) and s.endswith(ARMOR_FOOT)):
        raise TimelockError("not an armored age file")
    return base64.b64decode("".join(s[len(ARMOR_HEAD):-len(ARMOR_FOOT)].split()))


def decrypt(armored: str, signature: bytes | None = None) -> bytes:
    """Open a tlock ciphertext. Without ``signature`` it fetches the round's beacon from drand."""
    raw = _dearmor(armored)
    head, _, rest = raw.partition(b"\n--- ")
    lines = head.decode().split("\n")
    if lines[0] != AGE_VERSION:
        raise TimelockError("unsupported age version")
    try:
        i = next(k for k, l in enumerate(lines) if l.startswith("-> tlock "))
    except StopIteration:
        raise TimelockError("no tlock stanza") from None
    _, _, rnd, chain = lines[i].split(" ")
    if chain != CHAIN_HASH:
        raise TimelockError("encrypted for a drand network other than quicknet")
    body = ""
    for l in lines[i + 1:]:
        body += l
        if len(l) < 64:
            break
    sig = signature if signature is not None else beacon(int(rnd))
    file_key = ibe_decrypt(sig, _unb64(body))
    mac_line, _, payload = rest.partition(b"\n")
    want = hmac.new(_hkdf(file_key, b"", b"header"), head + b"\n---", hashlib.sha256).digest()
    if not hmac.compare_digest(_unb64(mac_line.decode()), want):
        raise TimelockError("header MAC does not match")
    return _stream(_hkdf(file_key, payload[:16], b"payload"), payload[16:], False)


def seconds_until(r: int) -> float:
    return round_time(r) - time.time()
