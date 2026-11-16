"""Small helpers shared by the server modules."""

from __future__ import annotations

import ipaddress
import mimetypes
import os
import re
import secrets
import tempfile
import time
import urllib.parse
from pathlib import Path


class BadRequest(Exception):
    """An error caused by the request; its message is shown to the user."""


class DeviceError(Exception):
    """The device could not be reached or isn't configured."""


def first_line(text: str) -> str:
    for line in (text or "").splitlines():
        if line.strip():
            return line.strip()[:300]
    return ""


def mask(secret: str) -> str:
    if not secret:
        return ""
    return "•" * 8 + secret[-4:] if len(secret) > 8 else "•" * len(secret)


def safe_name(name: str) -> str:
    """Reduce a client- or device-supplied file name to a harmless base name."""
    name = (name or "").replace("\\", "/").split("/")[-1]
    name = "".join(ch for ch in name if ch.isprintable()).strip()
    if name in ("", ".", ".."):
        return ""
    return name[:180]


def host_only(value: str) -> str:
    """Extract a bare host or IP from an address, URL or `host:port` string."""
    v = (value or "").strip()
    if not v:
        return ""
    if "://" in v:
        try:
            return urllib.parse.urlsplit(v).hostname or ""
        except ValueError:
            return ""
    v = v.split()[0]
    if v.startswith("[") and "]" in v:
        return v[1:v.index("]")]
    if v.count(":") == 1:
        v = v.split(":")[0]
    return v if re.fullmatch(r"[A-Za-z0-9.\-:%]+", v) else ""


def network_host_ok(host: str, names=()) -> bool:
    """The Host check for what other devices reach over the network (the panel in server mode, the gateway's listener
    for other computers): an IP address with any port, localhost, or one of `names` (lowercase, as browsers send them).
    A website trying to get in through DNS rebinding points a name it controls at this computer, so it sends that name
    and is refused. Any IP address is fine: port mapping and NAT (a container, a VM) change the address and port a
    request reaches, but not its Host."""
    host = (host or "").strip().lower()
    if host.startswith("["):   # [IPv6]:port
        name = host[1:host.find("]")] if "]" in host else ""
    else:
        name = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
    if not name:
        return False
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        return name == "localhost" or name in names


EXTRA_MIME = {".webmanifest": "application/manifest+json", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
              ".wasm": "application/wasm", ".m4a": "audio/mp4", ".opus": "audio/ogg", ".mjs": "text/javascript"}


def guess_mime(name: str) -> str:
    ext = os.path.splitext(name)[1].lower()
    return EXTRA_MIME.get(ext) or mimetypes.guess_type(name)[0] or "application/octet-stream"


def clamp_int(value, lo, hi, default):
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


GATEWAY_ERRORS = {502: "isn't running right now", 503: "isn't available right now", 504: "took too long to answer"}


def error_message(data, text, status):
    """Best human-readable message from a device error response."""
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, dict) and err.get("message"):
            return str(err["message"])
        for k in ("message", "detail", "error", "msg", "reason"):
            v = data.get(k)
            if isinstance(v, str) and v:
                return v
            if isinstance(v, list) and v and isinstance(v[0], dict):  # FastAPI validation errors
                return "; ".join(f"{'.'.join(map(str, d.get('loc', [])))}: {d.get('msg')}" for d in v[:4])
    t = (text or "").strip()
    head = t[:300].lower()
    if head.startswith(("<html", "<!doctype")) or "<title>" in head:
        # An error page from the device's web gateway (nginx), not from the service itself.
        m = re.search(r"<title>(.*?)</title>", t, re.I | re.S) or re.search(r"<h1>(.*?)</h1>", t, re.I | re.S)
        title = " ".join(re.sub(r"<[^>]+>", " ", m.group(1)).split()) if m else f"HTTP {status}"
        if status in GATEWAY_ERRORS:
            hint = (" After a restart or a power cut your Tiiny stays locked until you log in (Account → Log in, or tiiny login),"
                    " and its services need a minute to start after that.") if status in (502, 503) else ""
            return f"That part of your Tiiny {GATEWAY_ERRORS[status]} (the device answered “{title}”).{hint}"
        return f"The device answered “{title}”."
    return t[:400] if t else f"HTTP {status}"


def new_id(prefix: str = "") -> str:
    """Short random id that is safe in file names and URLs."""
    return prefix + secrets.token_hex(6)


def valid_id(value) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value))


def atomic_write(path: Path, data, mode: int = 0o600):
    """Write a file so readers never see a half-written version."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = data.encode("utf-8") if isinstance(data, str) else data
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def estimate_tokens(text: str) -> int:
    """Rough token count (about 4 characters per token for English and code)."""
    return max(1, (len(text) + 3) // 4) if text else 0


def now() -> float:
    return time.time()


def data_dir() -> Path:
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    d = Path(base) / "tiiny-ui"
    d.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(d, 0o700)
    except OSError:
        pass
    return d


class Usage:
    """When each model was last used through the panel (by id or by an alias such as 'default')."""

    def __init__(self):
        import threading
        self.lock = threading.Lock()
        self.last = {}

    def touch(self, model):
        if model and isinstance(model, str):
            with self.lock:
                self.last[model] = time.time()

    def get(self, model):
        with self.lock:
            return self.last.get(model)


USAGE = Usage()


class Borrowed:
    """Models the panel loaded just for a moment, to unload them again afterwards (🎤 and 🔊 in chats).

    A page borrows a model before it loads one that isn't loaded, uses it, then gives it back, saying how long to wait.
    Once nothing has used the model for that long, the panel unloads it (Metrics.borrowed_check). A model that was
    already loaded is never borrowed. A model stops being borrowed, and so stays loaded, when something else loads it
    for its own use (keep), when it's pinned, or when it's unloaded some other way."""

    HOLD_LIMIT = 600   # a page that's still "using" a model with no sign of life for this long was closed in the middle
    MAX = 50

    def __init__(self):
        import threading
        self.lock = threading.Lock()
        self.marks = {}   # model id -> {"since", "why", "users": {session: last sign of life}, "done", "after"}

    def borrow(self, model, session, *, loaded, why="voice", after=120) -> bool:
        """A page starts using `model`; `loaded`: it was loaded already. True when it's borrowed (to give back later)."""
        now = time.time()
        with self.lock:
            mk = self.marks.get(model)
            if mk is None:
                if loaded or len(self.marks) >= self.MAX:
                    return False
                mk = self.marks[model] = {"since": now, "why": why, "users": {}, "done": None, "after": after}
            if session in mk["users"] or len(mk["users"]) < self.MAX:
                mk["users"][session] = now
            mk["after"] = after
            return True

    def give_back(self, model, session, after) -> bool:
        """The page is done with it: unload it once nothing has used it for `after` seconds."""
        with self.lock:
            mk = self.marks.get(model)
            if mk is None:
                return False
            mk["users"].pop(session, None)
            mk["done"] = time.time()
            mk["after"] = after
            return True

    def keep(self, model) -> bool:
        """It stays loaded: something relies on it now."""
        with self.lock:
            return self.marks.pop(model, None) is not None

    def snapshot(self) -> dict:
        with self.lock:
            return {k: dict(v, users=dict(v["users"])) for k, v in self.marks.items()}

    def unchanged(self, model, users) -> bool:
        """Still borrowed, and no page started using it since `users` was read (checked just before unloading)."""
        with self.lock:
            mk = self.marks.get(model)
            return bool(mk) and mk["users"] == users

    def unloaded(self, model, users):
        """The panel unloaded it. Forget it, unless a page started using it while it was being unloaded: that page
        loads it again, and it's still borrowed, to give back when that page is done."""
        with self.lock:
            mk = self.marks.get(model)
            if mk is not None and mk["users"] == users:
                del self.marks[model]
            elif mk is not None:
                mk["since"] = time.time()


BORROWED = Borrowed()
