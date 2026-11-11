"""Signing this computer's browser in to the panel.

The panel listens on 127.0.0.1, but that address is reachable by every program and every user account on
the computer, not just your browser. So the API (and the session token it needs) only goes to a browser
holding a sign-in credential.

How a browser gets one: when the panel starts (or when you start it again while it's running), it opens a
one-time sign-in link. The page behind that link hands the browser a credential, which the browser keeps in
its storage for the panel's exact address (http://127.0.0.1:<port>). From then on the page swaps it for the
session token on each load.

Why browser storage and not a cookie: cookies for 127.0.0.1 are sent to every port on 127.0.0.1, so any
program running a small web server on this computer could collect a cookie just by getting your browser to
open its address once. Browser storage is kept per address including the port, and is never sent anywhere
by itself.

Links are made from a secret key in ~/.config/tiiny-ui/browser-key, readable only by you. Each link works
once and expires after CODE_TTL seconds. Credentials stay valid across restarts; deleting the key file and
restarting the panel signs every browser out.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time
from pathlib import Path

from .common import atomic_write

CODE_TTL = 600  # seconds a sign-in link works
DEVICE_CODE_TTL = 600  # seconds a server-mode device link from `python3 tiiny_ui.py pair` works
ROLES = ("owner", "limited")
STORAGE_KEY = "tiiny-ui-credential"  # where the page keeps the credential (localStorage, per address)


class BrowserAuth:
    def __init__(self, key_path: Path):
        self.path = Path(key_path)
        self.lock = threading.Lock()
        self.used = {}  # sign-in codes already redeemed -> when they expire
        self.key = self._load_or_create()

    def _load_or_create(self) -> bytes:
        try:
            key = bytes.fromhex(self.path.read_text().strip())
            if len(key) >= 32:
                return key
        except (OSError, ValueError):
            pass
        key = secrets.token_bytes(32)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write(self.path, key.hex() + "\n")  # mode 600
        return key

    def _mac(self, *parts: str) -> str:
        return hmac.new(self.key, "\x1f".join(parts).encode(), hashlib.sha256).hexdigest()

    # -- one-time sign-in links ----------------------------------------------------------------
    def mint_code(self) -> str:
        """A one-time sign-in code: <time>.<nonce>.<signature>."""
        ts, nonce = str(int(time.time())), secrets.token_hex(8)
        return f"{ts}.{nonce}.{self._mac('code', ts, nonce)[:40]}"

    def redeem(self, code: str) -> bool:
        parts = (code or "").split(".")
        if len(parts) != 3 or not parts[0].isdigit():
            return False
        ts, nonce, sig = parts
        age = time.time() - int(ts)
        if age > CODE_TTL or age < -60:
            return False
        if not hmac.compare_digest(sig, self._mac("code", ts, nonce)[:40]):
            return False
        with self.lock:
            now = time.time()
            self.used = {c: exp for c, exp in self.used.items() if exp > now}
            if code in self.used:
                return False
            self.used[code] = now + CODE_TTL + 60
        return True

    def link(self, base_url: str) -> str:
        return f"{base_url.rstrip('/')}/auth?code={self.mint_code()}"

    # -- the browser's credential --------------------------------------------------------------
    def credential(self, port: int) -> str:
        """What a signed-in browser keeps. Tied to the port, like the browser storage that holds it."""
        return self._mac("browser", "v2", str(int(port)))

    def check_credential(self, value: str, port: int) -> bool:
        return bool(value) and hmac.compare_digest(value.encode(), self.credential(port).encode())

    # -- device sign-in links for server mode (python3 tiiny_ui.py pair) -------------------------
    # In server mode every device signs in with a one-time link (tiinyui/pairing.py keeps one record per device). The
    # links the `pair` command prints are signed with this key, so making one only needs the config folder, not a
    # connection to the running panel. Pairing makes sure each one is used once.
    def mint_device_code(self, role: str = "owner") -> str:
        ts, nonce, role = str(int(time.time())), secrets.token_hex(8), role if role in ROLES else "limited"
        return f"d1.{ts}.{nonce}.{role}.{self._mac('device', ts, nonce, role)[:40]}"

    def check_device_code(self, code: str):
        """(role, expiry time) for a well-signed device code that hasn't expired, else None."""
        parts = (code or "").split(".")
        if len(parts) != 5 or parts[0] != "d1" or not parts[1].isdigit() or parts[3] not in ROLES:
            return None
        _, ts, nonce, role, sig = parts
        age = time.time() - int(ts)
        if age > DEVICE_CODE_TTL or age < -60:
            return None
        if not hmac.compare_digest(sig, self._mac("device", ts, nonce, role)[:40]):
            return None
        return role, int(ts) + DEVICE_CODE_TTL

    # -- telling a second start that this really is our panel ----------------------------------
    def proof(self, challenge: str) -> str:
        return self._mac("alive", challenge[:128])
