"""Phones and other devices: an optional second listener on the local network, open only to paired devices.

Pairing: this computer shows a QR code with a one-time link (valid for 5 minutes). Opening it on a
phone gives that browser a long-lived, HttpOnly session cookie. Only a hash of each session token is
stored, so the file can't be used to log in. Sessions can be revoked at any time. Every API call
from a paired device still needs the per-launch session token (the paired page carries it).

In server mode (tiiny_ui.py --server) every device signs in this way, and each one has a role: "owner" (full access,
like this computer's own browser) or "limited" (what phones may do). Signed links made by `python3 tiiny_ui.py pair`
(browserauth.py) are kept as used until they expire, so each works once, also across restarts. Devices paired before
server mode existed are limited.

The first device can also use the setup code (SetupCode): the panel's page asks for it while no device has full access,
and it's only on the server (a file next to the panel's data, and `python3 tiiny_ui.py code`), so nobody else on the
network can claim the panel.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import socket
import threading
import time
from collections import deque
from pathlib import Path

from .common import atomic_write, new_id

CODE_TTL = 300
SERVER_CODE_TTL = 600      # links made in server mode (System → Devices → Add a device)
ROLES = ("owner", "limited")
MAX_FAILURES = 20          # wrong or expired codes per 5 minutes before pairing pauses
COOKIE = "tiiny_session"


def _h(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def lan_ip_towards(target: str = "") -> str:
    """This computer's address on the network that leads to `target` (the Tiiny), else the default route."""
    for dest in ([target] if target else []) + ["192.168.0.1", "10.0.0.1"]:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                s.connect((dest.split("%")[0], 9))
                ip = s.getsockname()[0]
            finally:
                s.close()
            if ip and not ip.startswith("127."):
                return ip
        except OSError:
            continue
    return ""


SETUP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"   # no I, L, O, 0 or 1: nothing to mix up when typing it
SETUP_RE = re.compile(r"setup code: ([A-Z2-9]{4}-[A-Z2-9]{4})")


class SetupCode:
    """The code that sets up a server-mode panel from its own page while no device has full access: 8 characters
    (about 8.5 * 10^11 codes; wrong ones count toward the pairing pause), kept in a file that only the panel's user can
    read. The panel and `python3 tiiny_ui.py code` share it: it's made once (never two different ones) and stays the
    same until it's used."""

    def __init__(self, path: Path, how_to: str = ""):
        self.path = Path(path)
        self.how_to = how_to   # what the file says to do with it (the panel's address)

    def get(self, create: bool = True) -> str:
        try:
            m = SETUP_RE.search(self.path.read_text())
            if m:
                return m.group(1)
        except OSError:
            pass
        if not create:
            return ""
        code = "".join(secrets.choice(SETUP_ALPHABET) for _ in range(8))
        code = f"{code[:4]}-{code[4:]}"
        text = (f"Tiiny Control Panel setup code: {code}\n\n{self.how_to}\n" if self.how_to else
                f"Tiiny Control Panel setup code: {code}\n")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Written in full first, then linked into place in one step: a reader sees no file or the whole code, and
        # if the panel and the code command make one at the same moment, the first link wins and both use it.
        tmp = self.path.with_name(f".{self.path.name}.{secrets.token_hex(4)}")
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(text)
        try:
            os.link(str(tmp), str(self.path))
        except FileExistsError:
            return self.get(create=False)
        except OSError:   # a file system without hard links: put it in place unless one appeared meanwhile
            if not self.path.exists():
                os.replace(str(tmp), str(self.path))
                return code
            return self.get(create=False)
        finally:
            try:
                os.unlink(str(tmp))
            except OSError:
                pass
        return code

    def matches(self, typed: str) -> bool:
        code = self.get(create=False)
        clean = re.sub(r"[\s-]+", "", str(typed or "")).upper()
        return bool(code) and len(clean) == 8 and secrets.compare_digest(clean, code.replace("-", ""))

    def remove(self) -> None:
        try:
            self.path.unlink()
        except OSError:
            pass


class Pairing:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.codes = {}
        self.failures = deque(maxlen=200)
        self.sessions, self.used = [], {}
        try:
            data = json.loads(self.path.read_text())
            self.sessions = data.get("sessions", [])
            self.used = {k: v for k, v in (data.get("used") or {}).items() if isinstance(v, (int, float)) and v > time.time()}
        except (OSError, ValueError, AttributeError):
            self.sessions, self.used = [], {}

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write(self.path, json.dumps({"sessions": self.sessions, "used": self.used}, indent=1))

    def new_code(self, role: str = "limited", ttl: int = CODE_TTL) -> tuple:
        code = secrets.token_urlsafe(18)
        with self.lock:
            now = time.time()
            self.codes = {k: v for k, v in self.codes.items() if v[0] > now}
            while len(self.codes) >= 5:
                self.codes.pop(next(iter(self.codes)))
            self.codes[_h(code)] = (now + ttl, role if role in ROLES else "limited")
        return code, ttl

    def blocked(self) -> bool:
        cutoff = time.time() - 300
        return sum(1 for t in self.failures if t > cutoff) >= MAX_FAILURES

    def redeem(self, code: str, name: str, ip: str, signed=None):
        """A session token for a valid one-time code, else None. `signed` checks a signed device code
        (BrowserAuth.check_device_code, server mode only): it returns (role, expiry) or None."""
        with self.lock:
            if self.blocked():
                return None
            now, ch = time.time(), _h(code or "")
            entry = self.codes.pop(ch, None)
            role = None
            if entry and entry[0] >= now:
                role = entry[1]
            elif signed is not None and str(code or "").startswith("d1.") and ch not in self.used:
                ok = signed(code)
                if ok:
                    role = ok[0]
                    self.used = {k: v for k, v in self.used.items() if v > now}
                    self.used[ch] = ok[1] + 60
            if role is None:
                self.failures.append(now)
                return None
            token = secrets.token_urlsafe(32)
            self.sessions.append({"id": new_id("s"), "hash": _h(token), "name": (name or "Device")[:120], "ip": ip,
                                  "role": role, "created": now, "last_seen": now})
            self._save()
            return token

    def check(self, token: str, ip: str = ""):
        if not token:
            return None
        th = _h(token)
        with self.lock:
            for s in self.sessions:
                if secrets.compare_digest(s["hash"], th):
                    if time.time() - s.get("last_seen", 0) > 60:
                        s["last_seen"], s["ip"] = time.time(), ip or s.get("ip")
                        self._save()
                    return s
        return None

    def revoke(self, sid: str) -> bool:
        with self.lock:
            before = len(self.sessions)
            self.sessions = [s for s in self.sessions if s["id"] != sid]
            self._save()
            return len(self.sessions) != before

    def list(self) -> list:
        with self.lock:
            return [dict({k: s.get(k) for k in ("id", "name", "ip", "created", "last_seen")}, role=s.get("role") or "limited")
                    for s in self.sessions]

    def has_owner(self) -> bool:
        with self.lock:
            return any(s.get("role") == "owner" for s in self.sessions)

    def claim_first_owner(self, name: str, ip: str):
        """A full-access session for the first device (it typed the setup code), or None when one already exists."""
        with self.lock:
            if any(s.get("role") == "owner" for s in self.sessions):
                return None
            now, token = time.time(), secrets.token_urlsafe(32)
            self.sessions.append({"id": new_id("s"), "hash": _h(token), "name": (name or "Device")[:120], "ip": ip,
                                  "role": "owner", "created": now, "last_seen": now})
            self._save()
            return token

    def fail(self) -> None:
        """Count a wrong code toward the pause (blocked)."""
        with self.lock:
            self.failures.append(time.time())


def device_name(user_agent: str) -> str:
    ua = user_agent or ""
    for needle, name in (("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android device"), ("Macintosh", "Mac"),
                         ("Windows", "Windows PC"), ("CrOS", "Chromebook"), ("Linux", "Linux computer")):
        if needle in ua:
            browser = next((b for b in ("Edg", "Firefox", "Chrome", "Safari") if b in ua), "")
            return f"{name}{' · ' + {'Edg': 'Edge'}.get(browser, browser) if browser else ''}"
    return "Device"
