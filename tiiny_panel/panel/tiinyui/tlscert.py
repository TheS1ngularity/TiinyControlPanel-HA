"""The panel's own HTTPS certificate, made with Python's standard library only (no openssl, no packages).

Browsers only allow the microphone on secure pages. A panel on a home server, or the phone listener of a normal
install, is reached at a home-network address that no public certificate authority vouches for. So unless you give
the panel a certificate, it makes its own: RSA-2048, signed with SHA-256, self-signed, for the names and addresses
devices use to reach it. Each browser warns once (the panel explains why before that); after that the page counts
as secure and the microphone works.

    ensure(folder, names, ips) -> Cert(cert, key, fingerprint, made)

reuses the certificate in `folder` while it covers those names and addresses and has 30 or more days left, and
otherwise makes a new one that also covers what the old one did (so switching between Wi-Fi and Ethernet doesn't
cause a new warning every time).
"""

from __future__ import annotations

import base64
import datetime
import hashlib
import ipaddress
import json
import os
import secrets
import time
from pathlib import Path
from typing import NamedTuple

VALID_DAYS = 825        # the longest some systems accept for a certificate you choose to trust
RENEW_DAYS = 30
E = 65537
SMALL_PRIMES = [p for p in range(3, 2000, 2) if all(p % d for d in range(3, int(p ** 0.5) + 1, 2))]
NAME = "Tiiny Control Panel"


class Cert(NamedTuple):
    cert: str
    key: str
    fingerprint: str   # SHA-256 of the certificate, as browsers show it (AB:CD:...)
    made: bool         # made just now (else reused)


# -- RSA ----------------------------------------------------------------------------------------------------------

def _probable_prime(n: int, rounds: int = 40) -> bool:
    """Miller-Rabin with random bases."""
    if n < 2:
        return False
    for p in SMALL_PRIMES[:60]:
        if n % p == 0:
            return n == p
    d, r = n - 1, 0
    while d % 2 == 0:
        d //= 2
        r += 1
    for _ in range(rounds):
        x = pow(2 + secrets.randbelow(n - 3), d, n)
        if x in (1, n - 1):
            continue
        for _ in range(r - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _prime(bits: int) -> int:
    while True:
        # the top two bits set, so the product of two such primes has exactly 2 * bits bits
        c = secrets.randbits(bits) | (3 << (bits - 2)) | 1
        if any(c % p == 0 for p in SMALL_PRIMES) or (c - 1) % E == 0:
            continue
        if _probable_prime(c):
            return c


def rsa_key(bits: int = 2048) -> dict:
    while True:
        p, q = _prime(bits // 2), _prime(bits // 2)
        if p != q and (p * q).bit_length() == bits:
            break
    if p < q:
        p, q = q, p
    phi = (p - 1) * (q - 1)
    d = pow(E, -1, phi)
    return {"n": p * q, "e": E, "d": d, "p": p, "q": q, "dp": d % (p - 1), "dq": d % (q - 1), "qinv": pow(q, -1, p)}


def _sign(key: dict, data: bytes) -> bytes:
    """RSASSA-PKCS1-v1_5 with SHA-256, using the CRT; checked before it's returned."""
    k = (key["n"].bit_length() + 7) // 8
    t = _seq(_seq(_oid("2.16.840.1.101.3.4.2.1"), _null()), _octets(hashlib.sha256(data).digest()))
    m = int.from_bytes(b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t, "big")
    m1, m2 = pow(m, key["dp"], key["p"]), pow(m, key["dq"], key["q"])
    s = m2 + (key["qinv"] * (m1 - m2) % key["p"]) * key["q"]
    if pow(s, key["e"], key["n"]) != m:
        raise ValueError("The new certificate's signature didn't check out.")
    return s.to_bytes(k, "big")


# -- DER ----------------------------------------------------------------------------------------------------------

def _tlv(tag: int, content: bytes) -> bytes:
    n = len(content)
    if n < 0x80:
        size = bytes([n])
    else:
        b = n.to_bytes((n.bit_length() + 7) // 8, "big")
        size = bytes([0x80 | len(b)]) + b
    return bytes([tag]) + size + content


def _int(v: int) -> bytes:
    return _tlv(0x02, v.to_bytes(max(1, (v.bit_length() + 8) // 8), "big"))


def _seq(*parts: bytes) -> bytes:
    return _tlv(0x30, b"".join(parts))


def _set(*parts: bytes) -> bytes:
    return _tlv(0x31, b"".join(parts))


def _oid(dotted: str) -> bytes:
    nums = [int(x) for x in dotted.split(".")]
    body = bytearray([nums[0] * 40 + nums[1]])
    for n in nums[2:]:
        enc = [n & 0x7F]
        n >>= 7
        while n:
            enc.append(0x80 | (n & 0x7F))
            n >>= 7
        body += bytes(reversed(enc))
    return _tlv(0x06, bytes(body))


def _null() -> bytes:
    return b"\x05\x00"


def _octets(b: bytes) -> bytes:
    return _tlv(0x04, b)


def _bits(b: bytes) -> bytes:
    return _tlv(0x03, b"\x00" + b)


def _utf8(s: str) -> bytes:
    return _tlv(0x0C, s.encode())


def _time(dt: datetime.datetime) -> bytes:
    """UTCTime until 2049, GeneralizedTime from 2050 on (RFC 5280)."""
    if dt.year < 2050:
        return _tlv(0x17, dt.strftime("%y%m%d%H%M%SZ").encode())
    return _tlv(0x18, dt.strftime("%Y%m%d%H%M%SZ").encode())


def _ext(oid: str, value: bytes, critical: bool = False) -> bytes:
    return _seq(_oid(oid), (_tlv(0x01, b"\xff") if critical else b""), _octets(value))


def certificate(key: dict, names, ips, now: float = None) -> bytes:
    """A self-signed end-entity certificate (DER) for these DNS names and IP addresses."""
    now = time.time() if now is None else now
    start = datetime.datetime.fromtimestamp(int(now) - 86400, tz=datetime.timezone.utc)   # a day early, for clocks that lag
    end = datetime.datetime.fromtimestamp(int(now) + VALID_DAYS * 86400, tz=datetime.timezone.utc)
    name = _seq(_set(_seq(_oid("2.5.4.3"), _utf8(NAME))), _set(_seq(_oid("2.5.4.10"), _utf8(f"{NAME} (its own certificate)"))))
    rsa_pub = _seq(_int(key["n"]), _int(key["e"]))
    spki = _seq(_seq(_oid("1.2.840.113549.1.1.1"), _null()), _bits(rsa_pub))
    alt = b"".join([_tlv(0x82, n.encode("ascii")) for n in names] + [_tlv(0x87, ipaddress.ip_address(i).packed) for i in ips])
    exts = _seq(
        _ext("2.5.29.19", _seq(), critical=True),                         # basicConstraints: not a CA
        _ext("2.5.29.15", _tlv(0x03, b"\x05\xa0"), critical=True),        # keyUsage: digitalSignature, keyEncipherment
        _ext("2.5.29.37", _seq(_oid("1.3.6.1.5.5.7.3.1"))),               # extendedKeyUsage: serverAuth
        _ext("2.5.29.14", _octets(hashlib.sha1(rsa_pub).digest())),       # subjectKeyIdentifier
        _ext("2.5.29.17", _tlv(0x30, alt)),                               # subjectAltName
    )
    sig_alg = _seq(_oid("1.2.840.113549.1.1.11"), _null())                # sha256WithRSAEncryption
    serial = int.from_bytes(secrets.token_bytes(16), "big") >> 1 or 1     # positive, at most 16 bytes
    tbs = _seq(_tlv(0xA0, _int(2)), _int(serial), sig_alg, name, _seq(_time(start), _time(end)), name, spki, _tlv(0xA3, exts))
    return _seq(tbs, sig_alg, _bits(_sign(key, tbs)))


def _pem(label: str, der: bytes) -> str:
    b64 = base64.b64encode(der).decode()
    return f"-----BEGIN {label}-----\n" + "\n".join(b64[i:i + 64] for i in range(0, len(b64), 64)) + f"\n-----END {label}-----\n"


def key_pem(key: dict) -> str:
    """PKCS#1 RSAPrivateKey, which ssl.load_cert_chain reads."""
    return _pem("RSA PRIVATE KEY", _seq(*(_int(key[k]) if k else _int(0)
                                          for k in (None, "n", "e", "d", "p", "q", "dp", "dq", "qinv"))))


def fingerprint(der: bytes) -> str:
    return ":".join(f"{b:02X}" for b in hashlib.sha256(der).digest())


# -- the panel's certificate ---------------------------------------------------------------------------------------

def ascii_name(n) -> str:
    """A name as browsers send it and certificates hold it: lowercase, no final dot, and names with other letters (like
    büro.local) in their xn-- form. "" if it can't be written that way."""
    n = str(n or "").strip().lower().rstrip(".")
    if n.isascii():
        return n
    try:
        return n.encode("idna").decode("ascii")
    except UnicodeError:
        return ""


def _clean(names, ips):
    ns = {ascii_name(n) for n in names}
    ns = {n for n in ns if n and all(c.isalnum() or c in "-." for c in n)} | {"localhost"}
    ip_set = {"127.0.0.1", "::1"}
    for i in ips:
        try:
            ip_set.add(str(ipaddress.ip_address(str(i).strip().strip("[]"))))
        except ValueError:
            pass
    return sorted(ns), sorted(ip_set)


def _write(path: Path, text: str, mode: int) -> None:
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(str(tmp), str(path))


def ensure(folder, names=(), ips=(), now: float = None) -> Cert:
    folder = Path(folder)
    cert_p, key_p, meta_p = folder / "panel-cert.pem", folder / "panel-key.pem", folder / "panel-cert.json"
    now = time.time() if now is None else now
    want_names, want_ips = _clean(names, ips)
    old = {}
    try:
        old = json.loads(meta_p.read_text())
        if (cert_p.is_file() and key_p.is_file() and set(want_names) <= set(old["names"]) and set(want_ips) <= set(old["ips"])
                and old["not_after"] - now > RENEW_DAYS * 86400):
            return Cert(str(cert_p), str(key_p), old["fingerprint"], False)
    except (OSError, ValueError, KeyError, TypeError):
        old = old if isinstance(old, dict) else {}
    names_, ips_ = _clean(want_names + list(old.get("names") or []), want_ips + list(old.get("ips") or []))
    key = rsa_key()
    der = certificate(key, names_, ips_, now)
    folder.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(folder, 0o700)
    except OSError:
        pass
    _write(key_p, key_pem(key), 0o600)
    _write(cert_p, _pem("CERTIFICATE", der), 0o644)
    fp = fingerprint(der)
    _write(meta_p, json.dumps({"names": names_, "ips": ips_, "not_after": int(now) + VALID_DAYS * 86400, "fingerprint": fp,
                               "made": int(now)}, indent=1), 0o644)
    return Cert(str(cert_p), str(key_p), fp, True)
