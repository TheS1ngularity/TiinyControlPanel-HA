"""Talking to the Tiiny device's HTTP API (the same endpoints the official CLI uses)."""

from __future__ import annotations

import http.client
import ipaddress
import json
import os
import re
import secrets
import socket
import time
import urllib.parse
from pathlib import Path
from typing import TYPE_CHECKING

from .common import BORROWED, USAGE, BadRequest, DeviceError, atomic_write, clamp_int, error_message, guess_mime, host_only, mask

if TYPE_CHECKING:
    from .settings import Settings

from . import VERSION, activity
CLI_CONFIG_DEFAULT = Path.home() / ".local" / "tiiny" / "config.json"
MAX_DEVICE_RESPONSE = 64 * 1024 * 1024


SERVICES = {
    "core": (None, None),                    # models, inference (/v1/...), NPU and system status
    "p8800": (None, "p8800.api.tiiny"),      # power, download list and cancel
    "auth": (None, "auth.api.tiiny.local"),  # account
    "wifi": (None, "wifi.api.tiiny"),
    "kb": (None, "kb.tiiny.local"),          # vault, profile, summaries
    "connector": (None, "connector.api.tiiny"),
    "agents": (None, "agents.api.tiiny"),
    "upgrade": (None, "hardware-upgrade.api.tiiny"),  # TiinyOS updates (v2 API, see firmware.py); no longer on :5555
    "discovery": (39218, None),              # /device.json, no auth
}


FORWARD_HEADERS = {"x-user-id": "X-User-Id", "x-tiiny-model-instance": "X-Tiiny-Model-Instance", "accept": "Accept"}


DISCOVERY_PORT = 39217


DISCOVERY_TOKEN = b"GADGET_DISCOVER_V1"


class DeviceConn:
    """Where the device is and which key to use: page settings first, then the CLI's config."""

    def __init__(self, settings: Settings):
        self.settings = settings

    def cli_config_path(self) -> Path:
        p = self.settings.get("cli_config")
        return Path(os.path.expanduser(p)) if p else CLI_CONFIG_DEFAULT

    def resolve(self) -> dict:
        s = self.settings
        address, key = s.get("device_address"), s.get("api_key")
        sources = {"address": "settings" if address else "", "key": "settings" if key else ""}
        cfg_path = self.cli_config_path()
        cfg = read_cli_config(cfg_path)
        if not address:
            address = str(cfg.get("deviceAddress") or cfg.get("device_ip") or "")
            sources["address"] = "tiiny CLI config" if address else ""
        if not key:
            acct = cfg.get("account") if isinstance(cfg.get("account"), dict) else {}
            key = str(acct.get("authKey") or acct.get("auth_key") or cfg.get("api_key") or "")
            sources["key"] = "tiiny CLI config" if key else ""
        return {
            "address": host_only(address) or address.strip(),
            "port": clamp_int(s.get("device_port") or 80, 1, 65535, 80),
            "key": key,
            "sources": sources,
            "cli_config": str(cfg_path),
        }

    @staticmethod
    def public(info: dict) -> dict:
        return {"address": info["address"], "port": info["port"], "key_set": bool(info["key"]),
                "key_hint": mask(info["key"]), "sources": info["sources"], "cli_config": info["cli_config"]}


def read_cli_config(path: Path) -> dict:
    """Tiiny's tool's config, or {} when it's missing or isn't a JSON object."""
    try:
        cfg = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}
    return cfg if isinstance(cfg, dict) else {}


def save_cli_key(path: Path, key: str, address: str = "") -> None:
    """Keep a key the way `tiiny login` does: as account.authKey in Tiiny's tool's config (its other settings stay),
    readable only by you. The panel and the tool both use it from there."""
    cfg = read_cli_config(path)
    acct = cfg.get("account") if isinstance(cfg.get("account"), dict) else {}
    acct["authKey"] = key
    cfg["account"] = acct
    if address and not cfg.get("deviceAddress"):
        cfg["deviceAddress"] = address
    atomic_write(path, json.dumps(cfg, indent=2) + "\n", 0o600)


def grant_key(info: dict, password: str) -> dict:
    """Log in like `tiiny login` does: the device's password goes to its account service (and only there), which
    answers with a key for this computer. Returns {"key", "user"}. Raises BadRequest when the device says no, and
    DeviceError when it can't be reached. Unlike Tiiny's tool 0.0.6, this also works while the device is unlocked."""
    r = device_json(dict(info, key=""), "auth", "POST", "/api/v1/account/auth", body={"password": password}, timeout=30)
    data = r.get("json") if isinstance(r.get("json"), dict) else {}
    key = data.get("auth_key")
    if r.get("ok") and isinstance(key, str) and key:
        user = data.get("user_info") if isinstance(data.get("user_info"), dict) else {}
        return {"key": key, "user": str(user.get("user_name") or "")}
    if r.get("status") is None:
        raise DeviceError(r.get("error") or "Couldn't reach your Tiiny.")
    status = str(data.get("status") or "")
    if "activ" in status.lower():
        raise BadRequest("This Tiiny isn't activated yet. Use Activate a new device first.")
    if r.get("status") in (404, 405):
        raise BadRequest(f"Your Tiiny doesn't offer this way to log in (HTTP {r['status']}). Use Tiiny's tool instead.")
    said = next((v.strip() for v in (data.get(k) for k in ("msg", "message", "detail", "error")) if isinstance(v, str) and v.strip()), "")
    said = said or ("" if r.get("ok") else str(r.get("error") or "")) or status
    raise BadRequest("Your Tiiny didn't accept that password." + (f" It said: {said[:200]}" if said else ""))


def unlock_with_key(info: dict, key: str) -> str:
    """After a restart the device keeps its data locked until someone logs in: unlock it with the key, like
    `tiiny login` does. Returns the data state afterwards ("unlocked", "locked", or "" if the device didn't say)."""
    def state():
        c = device_json(info, "auth", "POST", "/api/v1/connect", body={"auth_key": key}, timeout=15)
        return str((c.get("json") or {}).get("data_state") or "") if isinstance(c.get("json"), dict) else ""
    now = state()
    if now != "locked":
        return now
    device_json(info, "auth", "POST", "/api/v1/account/unlock_with_auth_key", body={"auth_key": key}, timeout=60)
    return state()


def build_path(path, query=None) -> str:
    if not isinstance(path, str) or not path.startswith("/") or "://" in path or re.search(r"[\s\x00-\x1f]", path):
        raise BadRequest("Invalid device path")
    if query:
        if not isinstance(query, dict):
            raise BadRequest("query must be an object")
        qs = urllib.parse.urlencode({k: v for k, v in query.items() if v is not None and v != ""}, doseq=True)
        if qs:
            path += ("&" if "?" in path else "?") + qs
    return path


def device_open(info, service, method, path, *, body=None, headers=None, timeout=30):
    """Send a request to the device. Returns (connection, response); close the connection."""
    if service not in SERVICES:
        raise BadRequest(f"Unknown device service {service!r}")
    addr = info["address"]
    if not addr:
        raise DeviceError("No device is set up yet. Connect one under Network, or run `tiiny connect <ip>`.")
    port_override, host_header = SERVICES[service]
    port = port_override or info["port"]
    hdrs = {"Accept": "application/json", "User-Agent": f"TiinyUI/{VERSION}"}
    hdrs.update(headers or {})
    if host_header:
        hdrs["Host"] = host_header
    else:
        bare = addr.split("%")[0]
        hdrs["Host"] = (f"[{bare}]" if ":" in bare else bare) + ("" if port == 80 else f":{port}")
    if service != "discovery" and info["key"]:
        hdrs.setdefault("Authorization", "Bearer " + info["key"])
    conn = http.client.HTTPConnection(addr, port, timeout=timeout)
    try:
        conn.request(method, path, body=body, headers=hdrs)
        return conn, conn.getresponse()
    except (OSError, http.client.HTTPException) as e:
        conn.close()
        reason = "timed out" if isinstance(e, (socket.timeout, TimeoutError)) else str(e) or e.__class__.__name__
        raise DeviceError(f"Couldn't reach the device at {addr}:{port}: {reason}")


def device_json(info, service, method, path, *, body=None, timeout=10):
    """Small JSON request used by the overview; returns a result dict, never raises."""
    t0 = time.time()
    payload = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if payload is not None else {}
    try:
        conn, resp = device_open(info, service, method, path, body=payload, headers=headers, timeout=timeout)
    except DeviceError as e:
        return {"ok": False, "status": None, "error": str(e), "json": None}
    try:
        raw = resp.read(MAX_DEVICE_RESPONSE)
    except (OSError, http.client.HTTPException) as e:
        return {"ok": False, "status": resp.status, "error": f"Read failed: {e}", "json": None}
    finally:
        conn.close()
    text = raw.decode("utf-8", "replace")
    try:
        data = json.loads(text) if text.strip() else None
    except ValueError:
        data = None
    ok = 200 <= resp.status < 300
    out = {"ok": ok, "status": resp.status, "json": data, "duration": round(time.time() - t0, 3)}
    if not ok:
        out["error"] = error_message(data, text, resp.status)
    return out


def multipart_body(form, runtime):
    """Build a streamed multipart/form-data body from fields and uploaded files (ids in the runtime registry)."""
    if not isinstance(form, dict):
        raise BadRequest("form must be an object")
    files = []
    for name, fid in (form.get("files") or {}).items():
        rec = runtime.get_file(str(fid))
        if not rec or not os.path.isfile(rec["path"]):
            raise BadRequest("That uploaded file has expired. Please add it again.")
        files.append((name, rec["path"], rec["name"]))
    return multipart_paths(form.get("fields") or {}, files)


def multipart_paths(fields: dict, files: list):
    """Streamed multipart body from form fields and local files [(field, path, filename)]."""
    boundary = "----tiinyui" + secrets.token_hex(12)

    def q(s):
        return str(s).replace("\\", "\\\\").replace('"', "%22").replace("\r", "%0D").replace("\n", "%0A")

    parts = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{q(name)}"\r\n\r\n{value}\r\n'.encode())
    for name, path, filename in files:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{q(name)}"; filename="{q(filename)}"\r\n'
                     f'Content-Type: {guess_mime(filename)}\r\n\r\n'.encode())
        parts.append(("file", path))
        parts.append(b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    length = sum(len(p) if isinstance(p, bytes) else os.path.getsize(p[1]) for p in parts)

    def chunks():
        for p in parts:
            if isinstance(p, bytes):
                yield p
            else:
                with open(p[1], "rb") as f:
                    while True:
                        chunk = f.read(1 << 20)
                        if not chunk:
                            break
                        yield chunk

    return chunks(), f"multipart/form-data; boundary={boundary}", length


def _home_network_hosts() -> list:
    """Every other address in this machine's /24 on its home network. Some answers to a broadcast never come back
    (Fedora's firewall drops them, and some Wi-Fi filters broadcasts), but answers to a message sent to one address do.
    Private networks only, so a server on a public network never probes its neighbours."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("192.0.2.1", 9))   # picks the interface toward the network; nothing is sent
            me = s.getsockname()[0]
        finally:
            s.close()
        ip = ipaddress.ip_address(me)
    except (OSError, ValueError):
        return []
    if not ip.is_private or ip.is_loopback or ip.is_link_local:
        return []
    return [str(h) for h in ipaddress.ip_network(f"{me}/24", strict=False).hosts() if str(h) != me]


def discover_devices(extra_targets=(), wait=2.0):
    """UDP discovery, as `tiiny scan` does: broadcast GADGET_DISCOVER_V1 and collect replies. It also sends the message
    to each address on the home network (see _home_network_hosts), once."""
    found = {}
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    except OSError:
        return []
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        s.settimeout(0.25)
        targets = ["255.255.255.255"] + [t for t in extra_targets if t and ":" not in t]
        for _ in range(2):
            for t in targets:
                try:
                    s.sendto(DISCOVERY_TOKEN, (t, DISCOVERY_PORT))
                except OSError:
                    pass
        for t in _home_network_hosts():
            try:
                s.sendto(DISCOVERY_TOKEN, (t, DISCOVERY_PORT))
            except OSError:
                pass
        deadline = time.time() + wait
        while time.time() < deadline:
            try:
                data, (ip, _port) = s.recvfrom(65535)
            except socket.timeout:
                continue
            except (ConnectionRefusedError, ConnectionResetError):   # a "nothing here" from one of the addresses
                continue
            except OSError:
                break
            try:
                info = json.loads(data.decode("utf-8", "replace"))
            except ValueError:
                continue
            if isinstance(info, dict):
                key = info.get("device_id") or info.get("serial_number") or ip
                entry = found.setdefault(key, dict(info, addresses=[]))
                if ip not in entry["addresses"]:
                    entry["addresses"].append(ip)
    finally:
        s.close()
    return list(found.values())


# ---------------------------------------------------------------------------
# Helpers for background jobs (index building, memory, code review, studio)
# ---------------------------------------------------------------------------

def call(info, service, method, path, body=None, timeout=60, headers=None, raw_body=None, max_bytes=MAX_DEVICE_RESPONSE):
    """JSON request to the device. Returns (status, data_or_None, text)."""
    payload = raw_body if raw_body is not None else (json.dumps(body).encode() if body is not None else None)
    hdrs = {"Content-Type": "application/json"} if body is not None else {}
    hdrs.update(headers or {})
    model = body.get("model") if isinstance(body, dict) else None
    USAGE.touch(model)
    # model work shows on the dashboard as this panel's, under the job or page it's for
    with activity.track(path if method == "POST" and service == "core" else "", model):
        conn, resp = device_open(info, service, method, path, body=payload, headers=hdrs, timeout=timeout)
        try:
            raw = resp.read(max_bytes)
        except (OSError, http.client.HTTPException) as e:
            raise DeviceError(f"The device connection dropped: {e}")
        finally:
            conn.close()
    text = raw.decode("utf-8", "replace")
    try:
        data = json.loads(text) if text.strip() else None
    except ValueError:
        data = None
    return resp.status, data, text


def call_ok(info, service, method, path, body=None, timeout=60, headers=None):
    status, data, text = call(info, service, method, path, body=body, timeout=timeout, headers=headers)
    if not 200 <= status < 300:
        raise DeviceError(error_message(data, text, status))
    return data


def list_models(info) -> list:
    data = call_ok(info, "core", "GET", "/api/v1/models/", timeout=30) or {}
    return [m for m in data.get("data", []) if isinstance(m, dict) and m.get("id")]


def running_ids(info) -> list:
    data = call_ok(info, "core", "GET", "/v1/models", timeout=20) or {}
    return [m.get("id") for m in data.get("data", []) if isinstance(m, dict) and m.get("id")]


def pick_model(info, kind: str):
    """First downloaded model of a kind ('embed' or 'chat'), preferring loaded ones."""
    patterns = {"embed": r"embed", "chat": r"^(text generation|image-text-to-text)$"}
    pat = re.compile(patterns[kind], re.I)
    models = [m for m in list_models(info) if pat.search(m.get("type") or "")]
    if not models:
        return None
    running = set(running_ids(info))
    models.sort(key=lambda m: (m["id"] not in running, m.get("npu_usage") or 999))
    return models[0]["id"]


def ensure_loaded(info, model_id: str, timeout: float = 900, job=None):
    """Load a model (if needed) and wait until it serves requests."""
    BORROWED.keep(model_id)   # this work relies on it now: it isn't unloaded when 🎤 or 🔊 are done with it
    if not model_id or model_id == "default" or model_id in running_ids(info):
        return
    if job:
        job.update(message=f"Loading {model_id.split('/')[-1]} into NPU memory…")
    call_ok(info, "core", "POST", f"/api/v1/models/{urllib.parse.quote(model_id, safe='/')}/start", timeout=180)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if job:
            job.check()
        time.sleep(1.5)
        if model_id in running_ids(info):
            return
        status, data, _ = call(info, "core", "GET", f"/api/v1/models/{urllib.parse.quote(model_id, safe='/')}/get_progress", timeout=20)
        st = str((data or {}).get("status", ""))
        if re.search(r"fail|error", st, re.I):
            raise DeviceError(f"The device couldn't load {model_id}: {st}")
        if job and isinstance((data or {}).get("progress"), (int, float)) and re.search(r"load", st, re.I):
            job.update(message=f"Loading {model_id.split('/')[-1]}… {int(data['progress'])}%")
    raise DeviceError(f"{model_id} didn't finish loading in time")


def chat(info, model: str, messages: list, *, thinking=None, max_tokens=None, temperature=None,
         tools=None, timeout: float = 900) -> dict:
    """One non-streaming chat completion. Returns {'content', 'reasoning', 'tool_calls', 'usage', 'finish_reason'}."""
    body = {"model": model or "default", "messages": messages, "stream": False}
    if thinking is not None:
        body["chat_template_kwargs"] = {"enable_thinking": bool(thinking)}
    if max_tokens:
        body["max_tokens"] = int(max_tokens)
    if temperature is not None:
        body["temperature"] = float(temperature)
    if tools:
        body["tools"] = tools
    data = call_ok(info, "core", "POST", "/v1/chat/completions", body=body, timeout=timeout) or {}
    choice = (data.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    content = msg.get("content") or ""
    reasoning = msg.get("reasoning_content") or msg.get("reasoning") or ""
    if "</think>" in content:  # some templates put the reasoning inline
        head, _, tail = content.partition("</think>")
        reasoning = reasoning or head.replace("<think>", "").strip()
        content = tail
    return {"content": content.strip(), "reasoning": reasoning, "tool_calls": msg.get("tool_calls") or [],
            "usage": data.get("usage") or {}, "finish_reason": choice.get("finish_reason")}


class ChatError(DeviceError):
    """The device refused or broke off a chat completion. `status` is its HTTP status when it answered with one."""

    def __init__(self, message: str, status=None):
        super().__init__(message)
        self.status = status


def _text_of(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(p.get("text", "") for p in value if isinstance(p, dict))
    return ""


def stream_chat(info, payload: dict, extras: dict = None, *, timeout: float = 600):
    """A chat completion from the device, as it streams. The chat page (through /api/chat), code reviews and turns all
    read answers this way. Yields:
      ("info", text)                  e.g. the device didn't take the thinking options, so they were left out
      ("delta", content, reasoning)   pieces of the answer and of the reasoning
      ("tool_delta", tool_calls)      pieces of tool calls, as the device sends them (OpenAI's streaming format)
      ("done", stats)                 {usage, finish_reason, model, ttft, tps, tokens}
    Raises ChatError when the device refuses (HTTP error) or reports an error inside the stream, DeviceError when it
    can't be reached. `extras` (thinking options) are tried first, then left out if the device rejects them."""
    model = payload.get("model") or "default"
    attempts = [dict(payload, **extras), payload] if extras else [payload]
    for i, body in enumerate(attempts):
        t_sent = time.time()
        conn, resp = device_open(info, "core", "POST", "/v1/chat/completions", body=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Accept": "text/event-stream"}, timeout=timeout)
        try:
            if resp.status >= 400:
                text = resp.read(20_000).decode("utf-8", "replace")
                try:
                    data = json.loads(text)
                except ValueError:
                    data = None
                if extras and i == 0 and resp.status in (400, 422):
                    yield ("info", "The device didn't accept the thinking options, so this reply uses the model's default thinking mode.")
                    continue
                raise ChatError(f"The device answered HTTP {resp.status}: {error_message(data, text, resp.status)}", resp.status)
            if "event-stream" not in (resp.headers.get("Content-Type") or ""):
                raw = resp.read()
                try:
                    data = json.loads(raw)
                except ValueError:
                    raise ChatError("Unexpected reply from the device: " + raw[:300].decode("utf-8", "replace"))
                choice = (data.get("choices") or [{}])[0]
                msg = choice.get("message") or {}
                yield ("delta", _text_of(msg.get("content")), _text_of(msg.get("reasoning_content") or msg.get("reasoning")))
                if msg.get("tool_calls"):
                    yield ("tool_delta", [dict(tc, index=n) for n, tc in enumerate(msg["tool_calls"])])
                yield ("done", {"usage": data.get("usage"), "finish_reason": choice.get("finish_reason"),
                                "model": data.get("model") or model, "ttft": None, "tps": None, "tokens": None})
                return
            usage, finish, served = None, None, model
            t_first = t_last = None
            pieces = 0
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except ValueError:
                    continue
                if not isinstance(obj, dict):
                    continue
                if obj.get("error"):
                    err = obj["error"]
                    raise ChatError(err.get("message", str(err)) if isinstance(err, dict) else str(err))
                served = obj.get("model") or served
                if obj.get("usage"):
                    usage = obj["usage"]
                for choice in obj.get("choices") or []:
                    delta = choice.get("delta") or choice.get("message") or {}
                    content = _text_of(delta.get("content"))
                    reasoning = _text_of(delta.get("reasoning_content") or delta.get("reasoning"))
                    if content or reasoning or delta.get("tool_calls"):
                        t_last = time.time()
                        t_first = t_first or t_last
                        pieces += 1
                    if content or reasoning:
                        yield ("delta", content, reasoning)
                    if delta.get("tool_calls"):
                        yield ("tool_delta", delta["tool_calls"])
                    if choice.get("finish_reason"):
                        finish = choice["finish_reason"]
            stats = {"usage": usage, "finish_reason": finish, "model": served, "ttft": None, "tps": None, "tokens": None}
            if t_first:   # for the speed leaderboard
                tokens = (usage or {}).get("completion_tokens") or pieces
                gen = t_last - t_first
                stats.update(ttft=t_first - t_sent, tps=(tokens - 1) / gen if gen > 0.2 and tokens > 1 else None, tokens=tokens)
            yield ("done", stats)
            return
        finally:
            conn.close()


def chat_request(body: dict) -> tuple:
    """(payload, extras) for /v1/chat/completions from a chat request in the panel's own shape: model, messages,
    temperature/top_p/max_tokens, tools and tool_choice, thinking (on/off) and depth. Raises BadRequest."""
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise BadRequest("messages must be a non-empty list")
    payload = {"model": str(body.get("model") or "default"), "messages": messages, "stream": True}
    for k in ("temperature", "top_p", "max_tokens"):
        v = body.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            payload[k] = v
    if isinstance(body.get("tools"), list) and body["tools"]:
        payload["tools"] = body["tools"][:64]
        choice = body.get("tool_choice")
        if choice in ("auto", "none", "required") or isinstance(choice, dict):
            payload["tool_choice"] = choice
    extras = {}
    thinking = body.get("thinking")
    if isinstance(thinking, bool):
        extras["chat_template_kwargs"] = {"enable_thinking": thinking}
        depth = body.get("depth")
        if thinking and isinstance(depth, str) and re.fullmatch(r"[a-z]{2,12}", depth):
            extras["reasoning_effort"] = depth
    return payload, extras


def embed(info, model: str, texts: list, batch: int = 32, job=None) -> list:
    """Embeddings for many texts, batched. Returns one vector (list of floats) per text."""
    out = []
    for i in range(0, len(texts), batch):
        if job:
            job.check()
        part = [t[:24000] if t else " " for t in texts[i:i + batch]]
        data = call_ok(info, "core", "POST", "/v1/embeddings", body={"model": model, "input": part}, timeout=300) or {}
        rows = sorted(data.get("data", []), key=lambda d: d.get("index", 0))
        if len(rows) != len(part):
            raise DeviceError("The embedding model returned the wrong number of vectors")
        out.extend(r["embedding"] for r in rows)
    return out


def download(info, service, method, path, dest, *, body=None, headers=None, timeout=900, max_bytes=8 * 1024 ** 3, job=None):
    """Stream a device response into a file. Returns (status, headers, size, error_text).

    On a non-2xx answer nothing is written and error_text holds the device's message."""
    if isinstance(body, dict):
        USAGE.touch(body.get("model"))
    payload = json.dumps(body).encode() if body is not None else None
    hdrs = {"Content-Type": "application/json"} if body is not None else {}
    hdrs.update(headers or {})
    conn, resp = device_open(info, service, method, path, body=payload, headers=hdrs, timeout=timeout)
    try:
        rh = {k.lower(): v for k, v in resp.getheaders()}
        if not 200 <= resp.status < 300:
            raw = resp.read(1 << 20)
            text = raw.decode("utf-8", "replace")
            try:
                data = json.loads(text)
            except ValueError:
                data = None
            return resp.status, rh, 0, error_message(data, text, resp.status)
        total = 0
        with open(dest, "wb") as f:
            while True:
                if job:
                    job.check()
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise DeviceError("The device sent more data than expected.")
                f.write(chunk)
        return resp.status, rh, total, ""
    except (OSError, http.client.HTTPException) as e:
        raise DeviceError(f"The download from the device broke off: {e}")
    finally:
        conn.close()


def post_multipart(info, service, path, fields: dict, files: list, *, timeout=900):
    """multipart/form-data POST with local files [(field, path, filename)]. Returns parsed JSON (raises on errors)."""
    USAGE.touch(fields.get("model"))
    chunks, ctype, length = multipart_paths(fields, files)
    conn, resp = device_open(info, service, "POST", path, body=chunks,
                             headers={"Content-Type": ctype, "Content-Length": str(length)}, timeout=timeout)
    try:
        raw = resp.read(MAX_DEVICE_RESPONSE)
    except (OSError, http.client.HTTPException) as e:
        raise DeviceError(f"The device connection dropped: {e}")
    finally:
        conn.close()
    text = raw.decode("utf-8", "replace")
    try:
        data = json.loads(text) if text.strip() else None
    except ValueError:
        data = None
    if not 200 <= resp.status < 300:
        raise DeviceError(error_message(data, text, resp.status))
    return data


def vault_upload(info, work_dir, name: str, data: bytes, *, finalize=True, timeout=900) -> dict:
    """Save a file into the Vault (upload, then finalize so it is indexed). Returns {source_id, filename, indexed}."""
    import tempfile
    tmp = Path(tempfile.mkdtemp(dir=work_dir)) / name
    try:
        tmp.write_bytes(data)
        try:
            out = post_multipart(info, "kb", "/kb/upload", {}, [("file", str(tmp), name)], timeout=300) or {}
        except DeviceError as e:
            raise BadRequest(f"The Vault refused the file: {e}")
    finally:
        try:
            tmp.unlink()
            tmp.parent.rmdir()
        except OSError:
            pass
    sid = out.get("source_id")
    indexed = None
    if sid and finalize:
        status, data, _ = call(info, "kb", "POST", "/kb/finalize", body={"source_id": sid}, timeout=timeout)
        indexed = 200 <= status < 300 and not finalize_failed(data)
    return {"source_id": sid, "filename": name, "indexed": indexed}


def finalize_failed(data) -> str:
    """The Tiiny can answer /kb/finalize with 200 and "success": false (Tiiny's tool checks for it since 0.0.6). Returns
    why, or "" when it didn't say it failed (older versions don't send the flag)."""
    if not (isinstance(data, dict) and data.get("success") is False):
        return ""
    said = next((v.strip() for v in (data.get(k) for k in ("message", "msg", "detail", "error")) if isinstance(v, str) and v.strip()), "")
    return said or "Your Tiiny says indexing didn't succeed."
