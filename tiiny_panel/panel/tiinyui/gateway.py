"""The gateway: other apps on this computer use the Tiiny through the panel, each with its own key.

It listens on 127.0.0.1:8766 (settings: gateway_enabled, gateway_port; start flag --gateway-port) and speaks the APIs
the device speaks: OpenAI's (/v1/...), Anthropic's (/v1/messages) and Ollama's (/api/...). Apps used to get the
device's master key, which can also reboot the device or change its Wi-Fi. Here each app has its own key, made under
Integrations, with scopes (what it may use) and a loading policy. What a key can never do: manage models, the system,
Wi-Fi, the account, connectors or the Vault's contents beyond the MCP tools it's allowed. Only the endpoints below are
forwarded.

For every request it: checks the key and the scope; finds the model (an exact id, a short name, "default"); loads it
if needed, following the app's policy (tiinyui/npu.py), and borrows a model it had to load, so the panel unloads it
again a while after the app's last use (common.Borrowed); forwards the request with the device's key, relaying the
answer as it arrives (streams stay streams); and notes the work as the app's, so the dashboard's Right now names it.

Safety: only Host headers for this computer (against DNS rebinding); requests from web pages (an http(s) Origin) are
refused, with no CORS; keys are stored as hashes (apps.json, mode 600, like pairing.py); repeated wrong keys pause
answering. An optional second listener (gateway_lan) serves apps on other computers in your network.
"""

from __future__ import annotations

import collections
import hashlib
import ipaddress
import json
import re
import secrets
import socket
import ssl
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import VERSION, activity, device, npu
from .common import BORROWED, USAGE, DeviceError, atomic_write, error_message, new_id

DEFAULT_PORT = 8766
MAX_BODY = 100 * 1024 ** 2
KEY_PREFIX = "tiiny_"
MAX_FAILURES = 20           # wrong keys per 5 minutes from one address before the gateway stops listening to it
OLLAMA_VERSION = "0.12.0"   # what /api/version answers: Ollama apps check that they're talking to a recent enough server
SCOPES = {
    "chat": "Chat and text generation",
    "embeddings": "Embeddings and reranking",
    "images": "Making and editing pictures",
    "audio": "Speech recognition and text to speech",
    "ocr": "Reading text in pictures",
    "decisions": "Decision models",
    "vault_read": "Searching your Vault (MCP)",
    "vault_write": "Saving to your Vault (MCP)",
    "mcp": "Tools for AI assistants (MCP)",
}
DEFAULT_SCOPES = ["chat", "embeddings"]
UNLOAD_CHOICES = (0, 120, 600, 1800, 3600)
POLICIES = npu.POLICIES
# Kinds of models, by the device's "type" (the same tests as TYPES in static/app.js)
KINDS = {
    "chat": lambda m: re.match(r"^(text generation|image-text-to-text)$", m.get("type") or "", re.I),
    "embed": lambda m: re.search(r"embed", m.get("type") or "", re.I),
    "rerank": lambda m: re.search(r"rerank", m.get("type") or "", re.I),
    "asr": lambda m: re.search(r"^asr$|speech recognition|speech-to-text", m.get("type") or "", re.I),
    "tts": lambda m: re.search(r"text-to-speech|tts", m.get("type") or "", re.I),
    "image": lambda m: re.search(r"text-to-image", m.get("type") or "", re.I),
    "ocr": lambda m: re.search(r"image-to-text|ocr", m.get("type") or "", re.I) or m.get("is_ocr"),
    "decide": lambda m: re.search(r"classification", m.get("type") or "", re.I) or "systemone" in (m.get("capabilities") or []),
}
SCOPE_KINDS = {"chat": ("chat",), "embeddings": ("embed", "rerank"), "audio": ("asr", "tts"), "images": ("image",),
               "ocr": ("ocr",), "decisions": ("decide",)}
# The endpoints forwarded to the device: path -> (scope, API family for errors, kind of model)
FORWARD = {
    "/v1/chat/completions": ("chat", "openai", "chat"),
    "/v1/completions": ("chat", "openai", "chat"),
    "/v1/responses": ("chat", "openai", "chat"),
    "/v1/embeddings": ("embeddings", "openai", "embed"),
    "/v1/rerank": ("embeddings", "openai", "rerank"),
    "/v1/audio/speech": ("audio", "openai", "tts"),
    "/v1/audio/transcriptions": ("audio", "openai", "asr"),
    "/v1/images/generations": ("images", "openai", "image"),
    "/v1/image/generate": ("images", "openai", "image"),
    "/v1/ocr": ("ocr", "openai", "ocr"),
    "/v1/systemone": ("decisions", "openai", "decide"),
    "/v1/messages": ("chat", "anthropic", "chat"),
    "/v1/messages/count_tokens": ("chat", "anthropic", "chat"),
    "/api/chat": ("chat", "ollama", "chat"),
    "/api/generate": ("chat", "ollama", "chat"),
    "/api/embed": ("embeddings", "ollama", "embed"),
}
PASS_HEADERS = ("content-type", "accept", "anthropic-version", "anthropic-beta")


def _h(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def short(mid) -> str:
    return str(mid or "").split("/")[-1]


def family_of(path: str) -> str:
    if path.startswith("/api/"):
        return "ollama"
    if path.startswith("/v1/messages"):
        return "anthropic"
    return "openai"


class Refused(Exception):
    """A request the gateway answers with an error, in the API's own format."""

    def __init__(self, status: int, message: str, kind: str = ""):
        super().__init__(message)
        self.status, self.message, self.kind = status, message, kind


# -- apps and their keys ----------------------------------------------------------------------------------------
class Apps:
    """The apps allowed to use the gateway, in ~/.config/tiiny-ui/apps.json. Only a hash of each key is stored."""

    PUBLIC = ("id", "name", "preset", "hint", "scopes", "policy", "unload_after", "default_model", "created",
              "last_used", "last_model", "requests", "tokens_in", "tokens_out")

    def __init__(self, path: Path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.dirty, self.saved_at = False, 0.0
        try:
            self.apps = [a for a in json.loads(self.path.read_text()).get("apps", []) if isinstance(a, dict) and a.get("hash")]
        except (OSError, ValueError, AttributeError):
            self.apps = []
        self.keyless = self._new("Ollama apps (no key)", {"preset": "ollama", "scopes": ["chat", "embeddings"]})
        self.keyless.update(id="keyless", hash="")

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write(self.path, json.dumps({"apps": self.apps}, indent=1))
        self.dirty, self.saved_at = False, time.time()

    def flush(self, force=False):
        with self.lock:
            if self.dirty and (force or time.time() - self.saved_at > 30):
                self._save()

    @staticmethod
    def clean(spec: dict, base: dict = None) -> dict:
        """The settable fields of an app, checked."""
        out = {}
        if "name" in spec or base is None:
            name = str(spec.get("name") or "").strip()[:60]
            if not name:
                raise ValueError("Give the app a name.")
            out["name"] = name
        if "preset" in spec:
            out["preset"] = re.sub(r"[^a-z0-9-]", "", str(spec.get("preset") or "").lower())[:30] or "custom"
        if "scopes" in spec or base is None:
            scopes = [s for s in (spec.get("scopes") or DEFAULT_SCOPES) if s in SCOPES]
            if not scopes:
                raise ValueError("Choose at least one thing the app may use.")
            out["scopes"] = sorted(set(scopes), key=list(SCOPES).index)
        if "policy" in spec:
            if spec["policy"] not in POLICIES:
                raise ValueError("Unknown loading policy.")
            out["policy"] = spec["policy"]
        if "unload_after" in spec:
            v = spec["unload_after"]
            if v is not None and (not isinstance(v, int) or isinstance(v, bool) or v not in UNLOAD_CHOICES):
                raise ValueError("Unknown unload time.")
            out["unload_after"] = v
        if "default_model" in spec:
            out["default_model"] = str(spec.get("default_model") or "").strip()[:300]
        return out

    def _new(self, name, spec) -> dict:
        app = {"id": new_id("app"), "name": name, "preset": "custom", "hash": "", "hint": "", "scopes": list(DEFAULT_SCOPES),
               "policy": "fits", "unload_after": 600, "default_model": "", "created": time.time(), "last_used": None,
               "last_model": "", "requests": 0, "tokens_in": 0, "tokens_out": 0}
        app.update(self.clean(dict(spec, name=name)))
        return app

    @staticmethod
    def _key():
        key = KEY_PREFIX + secrets.token_urlsafe(32)
        return key, _h(key), key[-4:]

    def public(self, app) -> dict:
        return {k: app.get(k) for k in self.PUBLIC}

    def list(self) -> list:
        with self.lock:
            return [self.public(a) for a in self.apps]

    def create(self, spec: dict) -> tuple:
        app = self._new(str(spec.get("name") or "").strip()[:60], spec)
        key, app["hash"], app["hint"] = self._key()
        with self.lock:
            if len(self.apps) >= 100:
                raise ValueError("That's a lot of apps: revoke some you no longer use first.")
            self.apps.append(app)
            self._save()
        return self.public(app), key

    def _find(self, aid):
        return next((a for a in self.apps if a["id"] == aid), None)

    def update(self, aid: str, spec: dict) -> dict:
        changes = self.clean(spec, base={})
        with self.lock:
            app = self._find(aid)
            if not app:
                raise KeyError(aid)
            app.update(changes)
            self._save()
            return self.public(app)

    def new_key(self, aid: str) -> tuple:
        with self.lock:
            app = self._find(aid)
            if not app:
                raise KeyError(aid)
            key, app["hash"], app["hint"] = self._key()
            self._save()
            return self.public(app), key

    def revoke(self, aid: str) -> bool:
        with self.lock:
            before = len(self.apps)
            self.apps = [a for a in self.apps if a["id"] != aid]
            self._save()
            return len(self.apps) != before

    def check(self, key: str):
        if not key or not key.startswith(KEY_PREFIX):
            return None
        kh = _h(key)
        with self.lock:
            for a in self.apps:
                if secrets.compare_digest(a["hash"], kh):
                    return a
        return None

    def touch(self, app, model=None, tokens_in=0, tokens_out=0, request=False):
        with self.lock:
            if request:
                app["requests"] = int(app.get("requests") or 0) + 1
            app["tokens_in"] = int(app.get("tokens_in") or 0) + int(tokens_in or 0)
            app["tokens_out"] = int(app.get("tokens_out") or 0) + int(tokens_out or 0)
            app["last_used"] = time.time()
            if model:
                app["last_model"] = model
            self.dirty = app is not self.keyless or self.dirty
        self.flush()


# -- the listeners ----------------------------------------------------------------------------------------------
class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        import sys
        if isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError, ConnectionAbortedError, TimeoutError, ssl.SSLError)):
            return
        super().handle_error(request, client_address)


class Gateway:
    def __init__(self, devconn, settings, apps: Apps, *, tls=None, lan_ip=None, mcp=None, verbose=False):
        self.devconn, self.settings, self.apps = devconn, settings, apps
        self.tls, self.lan_ip, self.mcp, self.verbose = tls or {}, lan_ip, mcp, verbose
        self.lock = threading.Lock()
        self.servers = {"local": None, "lan": None}
        self.errors = {"local": "", "lan": ""}
        self.failures = collections.defaultdict(lambda: collections.deque(maxlen=MAX_FAILURES * 2))

    def port(self) -> int:
        return int(self.settings.get("gateway_port") or DEFAULT_PORT)

    def _start(self, which, host):
        try:
            srv = _Server((host, self.port()), Handler)
        except OSError as e:
            self.errors[which] = (f"Port {self.port()} is in use by another program." if getattr(e, "errno", None) in (98, 48, 10048)
                                  else f"Couldn't listen on {host}:{self.port()}: {e}")
            return
        srv.gateway, srv.lan = self, which == "lan"
        srv.hosts = {f"127.0.0.1:{self.port()}", f"localhost:{self.port()}", f"[::1]:{self.port()}"} if which == "local" \
            else {f"{host}:{self.port()}"}
        if which == "lan" and self.tls.get("cert"):
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(self.tls["cert"], self.tls["key"])
            srv.socket = ctx.wrap_socket(srv.socket, server_side=True, do_handshake_on_connect=False)
        threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.5}, daemon=True, name=f"gateway-{which}").start()
        self.servers[which], self.errors[which] = srv, ""

    def _stop(self, which):
        srv, self.servers[which] = self.servers[which], None
        if srv:
            srv.shutdown()
            srv.server_close()

    def apply(self):
        """Start, stop or move the listeners to match the settings."""
        with self.lock:
            want_local = bool(self.settings.get("gateway_enabled"))
            want_lan = want_local and bool(self.settings.get("gateway_lan"))
            for which, want in (("local", want_local), ("lan", want_lan)):
                srv = self.servers[which]
                if srv and (not want or srv.server_address[1] != self.port()):
                    self._stop(which)
                if not want:
                    self.errors[which] = ""
            if want_local and not self.servers["local"]:
                self._start("local", "127.0.0.1")
            if want_lan and not self.servers["lan"]:
                ip = self.lan_ip() if callable(self.lan_ip) else self.lan_ip
                if ip:
                    self._start("lan", ip)
                else:
                    self.errors["lan"] = "Couldn't find this computer's address on your network."

    def stop_all(self):
        with self.lock:
            self._stop("local")
            self._stop("lan")
        self.apps.flush(force=True)

    def status(self) -> dict:
        port = self.port()
        lan = self.servers["lan"]
        return {"enabled": bool(self.settings.get("gateway_enabled")), "running": bool(self.servers["local"]), "port": port,
                "url": f"http://127.0.0.1:{port}", "error": self.errors["local"],
                "lan": {"enabled": bool(self.settings.get("gateway_lan")), "running": bool(lan),
                        "url": f"{'https' if self.tls.get('cert') else 'http'}://{lan.server_address[0]}:{port}" if lan else "",
                        "tls": bool(self.tls.get("cert")), "error": self.errors["lan"]},
                "keyless_ollama": bool(self.settings.get("gateway_keyless_ollama")),
                "keyless_usage": self.apps.public(self.apps.keyless)}

    # -- wrong keys -------------------------------------------------------------------------------------------
    def blocked(self, ip) -> bool:
        cutoff = time.time() - 300
        return sum(1 for t in self.failures[ip] if t > cutoff) >= MAX_FAILURES

    def failed(self, ip):
        self.failures[ip].append(time.time())


# -- finding the model ------------------------------------------------------------------------------------------
def kind_ok(m: dict, kind: str) -> bool:
    return bool(KINDS[kind](m)) if kind in KINDS else False


def usable(app, m: dict) -> bool:
    """May this app use this model at all (by its scopes)?"""
    return any(kind_ok(m, k) for s in app["scopes"] for k in SCOPE_KINDS.get(s, ()))


def resolve(name, kind: str, app, info) -> str:
    """The device's id for what the app asked for: an exact id, the same id in other letters, a short name (with an
    Ollama ":tag" taken off), an alias the device lists, or "default"/"auto"/nothing."""
    models = [m for m in npu.models(info) if not npu.DL_BUSY.match(str(m.get("status") or ""))]
    ids = {m["id"]: m for m in models}
    n = str(name or "").strip()
    if n and n.lower() not in ("default", "auto"):
        if n in ids:
            return n
        low = n.lower()
        base = low[:-7] if low.endswith(":latest") else low
        hits = [i for i in ids if i.lower() in (low, base)] or [i for i in ids if i.split("/")[-1].lower() in (low, base)]
        if not hits and ":" in base:
            hits = [i for i in ids if i.split("/")[-1].lower() == base.split(":")[0]]
        if not hits:
            for mid, aliases in (getattr(npu._ctx.get("metrics"), "aliases", None) or {}).items():
                if low in [str(a).lower() for a in aliases or []] and mid in ids:
                    hits = [mid]
                    break
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            raise Refused(400, f"“{n}” matches several models on your Tiiny: {', '.join(hits)}. Use the full name.", "invalid_request")
        raise Refused(404, f"There's no model called “{n}” on your Tiiny.", "not_found")
    # default: a loaded one of the right kind (the app's last one first), else the app's default, else the smallest
    of_kind = [m for m in models if kind_ok(m, kind)]
    if not of_kind:
        raise Refused(404, f"There's no {kind_names(kind)} model on your Tiiny.", "not_found")
    running = set(device.running_ids(info))
    loaded = [m["id"] for m in of_kind if m["id"] in running]
    if app.get("last_model") in loaded:
        return app["last_model"]
    if loaded:
        return loaded[0]
    if app.get("default_model") in ids and kind_ok(ids[app["default_model"]], kind):
        return app["default_model"]
    return min(of_kind, key=lambda m: float(m.get("npu_usage") or 999))["id"]


def kind_names(kind) -> str:
    return {"chat": "chat", "embed": "embedding", "rerank": "reranking", "asr": "speech recognition", "tts": "text-to-speech",
            "image": "image", "ocr": "OCR", "decide": "decision"}.get(kind, kind)


# -- multipart: the model field of an upload -------------------------------------------------------------------------
def multipart_model(body: bytes, ctype: str):
    """(value, start, end) of the "model" field of a multipart/form-data body, or None."""
    m = re.search(r'boundary="?([^";]+)"?', ctype or "")
    if not m:
        return None
    sep = b"--" + m.group(1).encode()
    pos = 0
    while True:
        i = body.find(sep, pos)
        if i < 0:
            return None
        head_end = body.find(b"\r\n\r\n", i)
        if head_end < 0:
            return None
        head = body[i:head_end].decode("latin-1")
        nxt = body.find(b"\r\n" + sep, head_end)
        if nxt < 0:
            return None
        if re.search(r'name="model"', head) and "filename=" not in head:
            return body[head_end + 4:nxt].decode("utf-8", "replace"), head_end + 4, nxt
        pos = nxt + 2


# -- token counts from answers -----------------------------------------------------------------------------------
def usage_of(obj) -> tuple:
    """(tokens in, tokens out) from an OpenAI, Anthropic or Ollama answer or stream event; zeros if it has none."""
    if not isinstance(obj, dict):
        return 0, 0
    u = next((x.get("usage") for x in (obj, obj.get("message"), obj.get("response")) if isinstance(x, dict) and isinstance(x.get("usage"), dict)), {})
    try:
        tin = u.get("prompt_tokens") or u.get("input_tokens") or obj.get("prompt_eval_count") or 0
        tout = u.get("completion_tokens") or u.get("output_tokens") or obj.get("eval_count") or 0
        return int(tin or 0), int(tout or 0)
    except (TypeError, ValueError):
        return 0, 0


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"TiinyGateway/{VERSION}"
    timeout = 120   # an idle kept-open connection is closed after this (answers themselves can take as long as they need)

    def log_message(self, fmt, *args):
        if self.server.gateway.verbose:
            super().log_message(fmt, *args)

    # -- plumbing ---------------------------------------------------------------------------------------------
    def send_response(self, code, message=None):
        self._started = True   # from here on an error can't be sent as an answer of its own
        super().send_response(code, message)

    def send_raw(self, status, data: bytes, ctype: str, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_json(self, status, obj, extra=None):
        self.send_raw(status, json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8", extra)

    def refuse(self, family, status, message, kind=""):
        if family == "anthropic":
            types = {400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error",
                     413: "request_too_large", 429: "rate_limit_error"}
            body = {"type": "error", "error": {"type": types.get(status, "api_error"), "message": message}}
        elif family == "ollama":
            body = {"error": message}
        else:
            types = {400: "invalid_request_error", 401: "invalid_request_error", 403: "permission_error", 404: "not_found_error",
                     413: "invalid_request_error", 429: "rate_limit_error"}
            codes = {401: "invalid_api_key", 404: "model_not_found" if kind == "not_found" else None, 409: "model_not_ready"}
            body = {"error": {"message": message, "type": types.get(status, "server_error"), "code": codes.get(status) or kind or None}}
        self.send_json(status, body, {"WWW-Authenticate": 'Bearer realm="tiiny"'} if status == 401 else None)

    def client_ip(self) -> str:
        return self.client_address[0] if self.client_address else ""

    def loopback(self) -> bool:
        try:
            return ipaddress.ip_address(self.client_ip().split("%")[0]).is_loopback
        except ValueError:
            return False

    def read_body(self) -> bytes:
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            self.close_connection = True
            raise Refused(411, "Send the request with a Content-Length.", "invalid_request")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            self.close_connection = True
            raise Refused(413, "That request is too large (100 MB at most).", "invalid_request")
        return self.rfile.read(length) if length else b""

    def key(self) -> str:
        auth = self.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        return (self.headers.get("x-api-key") or self.headers.get("api-key") or "").strip()

    # -- every request ----------------------------------------------------------------------------------------
    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def do_HEAD(self):
        self.handle_any("HEAD")

    def do_DELETE(self):
        self.handle_any("DELETE")

    def do_PUT(self):
        self.handle_any("PUT")

    def do_PATCH(self):
        self.handle_any("PATCH")

    def do_OPTIONS(self):
        self.handle_any("OPTIONS")

    def handle_any(self, method):
        gw = self.server.gateway
        self._started = False
        url = urllib.parse.urlsplit(self.path)
        path = url.path.rstrip("/") or "/"
        family = family_of(path)
        try:
            host = (self.headers.get("Host") or "").strip().lower()
            if host not in self.server.hosts:
                self.close_connection = True
                return self.send_raw(403, b"Forbidden host", "text/plain; charset=utf-8")
            origin = (self.headers.get("Origin") or "").strip().lower()
            if origin.startswith(("http://", "https://")) or origin == "null":
                self.close_connection = True
                raise Refused(403, "Web pages can't use the Tiiny gateway. Connect from an app or from your own code instead.", "forbidden")
            body = self.read_body() if method in ("POST", "PUT", "PATCH") else b""
            if path == "/" and method in ("GET", "HEAD"):
                return self.send_raw(200, f"Tiiny gateway {VERSION}. Make a key for your app in the Tiiny Control Panel, under Integrations.\n".encode(),
                                     "text/plain; charset=utf-8")
            if path == "/mcp":
                app = self.authorize(family="openai", scope="mcp")
                if not gw.mcp:
                    raise Refused(404, "MCP isn't available.", "not_found")
                return gw.mcp(self, method, body, app)
            if method == "OPTIONS":
                return self.send_raw(204, b"", "text/plain", {"Allow": "GET, POST"})
            app = self.authorize(family, scope=None, path=path)
            if method in ("GET", "HEAD"):
                if path == "/v1/models":
                    return self.list_models_openai(app)
                if path.startswith("/v1/models/"):
                    return self.one_model_openai(app, urllib.parse.unquote(path[len("/v1/models/"):]))
                if path == "/api/tags":
                    return self.list_tags(app, "/api/tags")
                if path == "/api/ps":
                    return self.list_tags(app, "/api/ps")
                if path == "/api/version":
                    return self.send_json(200, {"version": OLLAMA_VERSION})
            if method == "POST" and path == "/api/show":
                return self.show_model(app, body)
            if method == "POST" and path in FORWARD:
                return self.forward(app, path, url.query, body)
            raise Refused(404, f"The Tiiny gateway doesn't offer {method} {path}.", "not_found")
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True
        except (Refused, DeviceError) as e:
            if self._started:   # the answer had begun: all that's left is to end it
                self.close_connection = True
                return
            if isinstance(e, Refused):
                self.refuse(family, e.status, e.message, e.kind)
            elif isinstance(e, npu.NotReady):
                self.refuse(family, 409 if family != "anthropic" else 400, str(e), "model_not_ready")
            else:
                self.refuse(family, 502, f"Your Tiiny didn't answer: {e}", "device")

    def authorize(self, family, scope=None, path="") -> dict:
        gw = self.server.gateway
        ip = self.client_ip()
        if gw.blocked(ip):
            raise Refused(429, "Too many wrong keys from here. Wait a few minutes, then use the key the Tiiny Control Panel gave you.", "rate_limited")
        key = self.key()
        app = gw.apps.check(key)
        if app is None and not key and path.startswith("/api/") and gw.settings.get("gateway_keyless_ollama") \
                and self.loopback() and not self.server.lan:
            app = gw.apps.keyless
        if app is None:
            if key:
                gw.failed(ip)
            raise Refused(401, "This needs a key for the Tiiny gateway. Make one for your app in the Tiiny Control Panel, under Integrations."
                          if not key else "That key isn't valid (any more). Make a new one in the Tiiny Control Panel, under Integrations.", "invalid_api_key")
        if scope and scope not in app["scopes"]:
            raise Refused(403, f"{app['name']} isn't allowed to use {SCOPES.get(scope, scope).lower()}. You can allow it under Integrations.", "forbidden")
        return app

    # -- answered here ----------------------------------------------------------------------------------------
    def _models_for(self, app, info):
        models = [m for m in npu.models(info) if usable(app, m) and not npu.DL_BUSY.match(str(m.get("status") or ""))]
        running = set(device.running_ids(info))
        if app.get("policy") == "loaded":
            models = [m for m in models if m["id"] in running]
        return models, running

    def list_models_openai(self, app):
        info = self.server.gateway.devconn.resolve()
        models, running = self._models_for(app, info)
        self.send_json(200, {"object": "list", "data": [self._openai_model(m, running) for m in models]})

    @staticmethod
    def _openai_model(m, running) -> dict:
        return {"id": m["id"], "object": "model", "created": int(m.get("created") or 0) if str(m.get("created") or "").isdigit() else 0,
                "owned_by": m["id"].split("/")[0] if "/" in m["id"] else "tiiny", "type": m.get("type"),
                "loaded": m["id"] in running, "context_window": m.get("context_window")}

    def one_model_openai(self, app, mid):
        info = self.server.gateway.devconn.resolve()
        models, running = self._models_for(app, info)
        m = next((x for x in models if x["id"] == mid), None)
        if not m:
            raise Refused(404, f"There's no model called “{mid}” for this app.", "not_found")
        self.send_json(200, self._openai_model(m, running))

    def list_tags(self, app, path):
        info = self.server.gateway.devconn.resolve()
        status, data, text = device.call(info, "core", "GET", path, timeout=20)
        if not 200 <= status < 300 or not isinstance(data, dict):
            raise DeviceError(error_message(data, text, status))
        allowed = {m["id"] for m in self._models_for(app, info)[0]}
        data["models"] = [m for m in data.get("models") or [] if (m.get("model") or m.get("name")) in allowed]
        self.send_json(200, data)

    def show_model(self, app, body):
        try:
            req = json.loads(body or b"{}")
        except ValueError:
            raise Refused(400, "The request isn't valid JSON.", "invalid_request")
        info = self.server.gateway.devconn.resolve()
        mid = resolve(req.get("model") or req.get("name"), "chat", app, info)
        m = next((x for x in npu.models(info) if x["id"] == mid), {"id": mid})
        if not usable(app, m):
            raise Refused(404, f"There's no model called “{mid}” for this app.", "not_found")
        arch = re.sub(r"[^a-z0-9]+", "", mid.split("/")[-1].split("-")[0].lower()) or "tiiny"
        caps = ["completion"] if kind_ok(m, "chat") else ["embedding"] if kind_ok(m, "embed") else []
        if "image" in str(m.get("input") or "").lower():
            caps.append("vision")
        if (m.get("thinking") or {}).get("supported"):
            caps.append("thinking")
        self.send_json(200, {"modelfile": "", "parameters": "", "template": "", "license": "",
                             "details": {"parent_model": "", "format": "", "family": arch, "families": [arch],
                                         "parameter_size": m.get("params") or "", "quantization_level": ""},
                             "model_info": {"general.architecture": arch, f"{arch}.context_length": m.get("context_window") or 0},
                             "capabilities": caps, "modified_at": "1970-01-01T00:00:00Z"})

    # -- forwarded to the device ------------------------------------------------------------------------------
    def forward(self, app, path, query, body):
        gw = self.server.gateway
        scope, family, kind = FORWARD[path]
        if scope not in app["scopes"]:
            raise Refused(403, f"{app['name']} isn't allowed to use {SCOPES[scope].lower()}. You can allow it under Integrations.", "forbidden")
        ctype = self.headers.get("Content-Type") or ""
        info = gw.devconn.resolve()
        qs = urllib.parse.parse_qs(query, keep_blank_values=True)
        req, asked, where = None, None, None
        if "multipart/form-data" in ctype:
            found = multipart_model(body, ctype)
            asked, where = (found[0], found[1:]) if found else (None, None)
        elif body:
            try:
                req = json.loads(body)
            except ValueError:
                raise Refused(400, "The request isn't valid JSON.", "invalid_request")
            if not isinstance(req, dict):
                raise Refused(400, "The request should be a JSON object.", "invalid_request")
            asked = req.get("model")
        if asked is None and "model" in qs:
            asked = qs["model"][0]
        model = resolve(asked, kind, app, info)
        # the device gets the model's real id
        if req is not None:
            req["model"] = model
            body = json.dumps(req).encode()
        elif where:
            body = body[:where[0]] + model.encode() + body[where[1]:]
        if "model" in qs or path == "/v1/ocr":
            qs["model"] = [model]
        path_qs = path + ("?" + urllib.parse.urlencode(qs, doseq=True) if qs else "")
        headers = {k: v for k, v in self.headers.items() if k.lower() in PASS_HEADERS}
        gw.apps.touch(app, model, request=True)
        with npu.use(model, policy=app.get("policy") or "fits", requester=app["name"], unload_after=app.get("unload_after"), why=app["name"]):
            with activity.track(path, model, title=app["name"]):
                USAGE.touch(model)
                conn, resp = device.device_open(info, "core", "POST", path_qs, body=body, headers=headers, timeout=900)
                try:
                    if resp.status == 404:   # unloaded a moment ago (another app, the page): load it again, once
                        peek = resp.read(4096)
                        if b"not loaded" in peek:
                            conn.close()
                            npu.ensure_ready(model, policy=app.get("policy") or "fits", requester=app["name"], info=info)
                            conn, resp = device.device_open(info, "core", "POST", path_qs, body=body, headers=headers, timeout=900)
                        else:
                            return self.relay_bytes(resp.status, resp, peek, app, family)
                    self.relay(resp, app, family)
                finally:
                    conn.close()

    def relay_bytes(self, status, resp, data, app, family):
        data += resp.read()
        self.send_raw(status, data, resp.headers.get("Content-Type") or "application/json")

    def relay(self, resp, app, family):
        """Send the device's answer on as it arrives, counting the tokens on the way."""
        ctype = resp.headers.get("Content-Type") or "application/octet-stream"
        length = resp.headers.get("Content-Length")
        streaming = length is None
        self.send_response(resp.status)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        if streaming:
            self.send_header("Connection", "close")
            self.send_header("X-Accel-Buffering", "no")
            self.close_connection = True
        else:
            self.send_header("Content-Length", length)
        self.end_headers()
        tin = tout = 0
        textual = "json" in ctype or "event-stream" in ctype or "ndjson" in ctype
        tail = b""
        read = getattr(resp, "read1", None) or resp.read
        while True:
            chunk = read(65536)
            if not chunk:
                break
            self.wfile.write(chunk)
            if streaming:
                self.wfile.flush()
            if textual and (streaming or len(tail) < 8 * 1024 ** 2):
                tail += chunk
                if streaming:
                    *lines, tail = tail.split(b"\n")
                    for line in lines:
                        a, b = self._line_usage(line)
                        tin, tout = max(tin, a), max(tout, b)
        if textual and tail:
            for line in ([tail] if not streaming else tail.split(b"\n")):
                a, b = self._line_usage(line)
                tin, tout = max(tin, a), max(tout, b)
        if 200 <= resp.status < 300 and (tin or tout):
            self.server.gateway.apps.touch(app, None, tin, tout)

    @staticmethod
    def _line_usage(line: bytes) -> tuple:
        line = line.strip()
        if line.startswith(b"data:"):
            line = line[5:].strip()
        if not line.startswith(b"{"):
            return 0, 0
        try:
            return usage_of(json.loads(line))
        except Exception:  # noqa: BLE001 - counting tokens must never break an answer
            return 0, 0
