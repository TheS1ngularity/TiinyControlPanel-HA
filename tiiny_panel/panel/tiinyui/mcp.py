"""MCP: AI assistants (Claude Code, Claude Desktop, Cursor, …) use the Tiiny's tools (tools.py).

Two ways in:
  * HTTP: POST /mcp on the gateway (127.0.0.1:8766), with an app key that has the "mcp" scope. Stateless JSON answers.
  * stdio: `python3 tiiny_ui.py mcp`, for assistants that start a program. This bridge passes each message to the
    running panel's /mcp, with the key from TIINY_KEY or --key-file. It also lets the assistant name files on this
    computer (audio_path, image_path, path): the bridge reads them and sends their bytes, so the panel itself never
    opens a path an app gives it.

Both protocol styles are served:
  * 2026-07-28, the current one: no handshake. Every request carries _meta with its protocol version; HTTP requests
    repeat it in headers (MCP-Protocol-Version, Mcp-Method, Mcp-Name), which must match. server/discover tells what's
    supported. Results carry resultType.
  * 2025-03-26, 2025-06-18 and 2025-11-25: initialize first, then requests. No sessions are kept (none are given out).
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

from . import VERSION

MODERN = ("2026-07-28",)
LEGACY = ("2025-11-25", "2025-06-18", "2025-03-26")
SUPPORTED = MODERN + LEGACY
PV = "io.modelcontextprotocol/protocolVersion"
SERVER_INFO = {"name": "tiiny", "title": "Tiiny", "version": VERSION}
INSTRUCTIONS = ("These tools run on the user's Tiiny, a small AI computer on their desk, so what they process stays on their "
                "own hardware. Models load when a tool needs them, which can take a few seconds to a minute the first time.")
CACHE = {"ttlMs": 300000, "cacheScope": "private"}   # the tool list depends on the app's key
# tools/call arguments the stdio bridge fills from a file on this computer: tool -> (path argument, base64 argument)
PATH_ARGS = {"tiiny_transcribe": ("audio_path", "audio"), "tiiny_ocr": ("image_path", "image"),
             "tiiny_edit_image": ("image_path", "image"), "tiiny_save_to_vault": ("path", "data")}


def header_value(v):
    """A header as sent: plain, or =?base64?…?= for values that aren't plain ASCII."""
    v = v or ""
    if v.startswith("=?base64?") and v.endswith("?="):
        try:
            return base64.b64decode(v[9:-2]).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return None
    return v


def encode_header(v: str) -> str:
    if v and all(32 <= ord(c) < 127 for c in v) and v == v.strip() and not v.startswith("=?base64?"):
        return v
    return "=?base64?" + base64.b64encode(v.encode("utf-8")).decode() + "?="


class Server:
    """POST /mcp on the gateway. `handle` is what gateway.Handler calls, with the app whose key came along."""

    def __init__(self, toolbox):
        self.toolbox = toolbox

    def reply(self, h, status, mid, result=None, error=None):
        body = {"jsonrpc": "2.0", "id": mid}
        if error is not None:
            body["error"] = error
        else:
            body["result"] = result
        h.send_json(status, body)

    @staticmethod
    def err(code, message, data=None) -> dict:
        e = {"code": code, "message": message}
        if data is not None:
            e["data"] = data
        return e

    def handle(self, h, method, body, app):
        if method != "POST":
            return h.send_raw(405, b"", "text/plain", {"Allow": "POST"})
        try:
            msg = json.loads(body or b"")
        except ValueError:
            return self.reply(h, 400, None, error=self.err(-32700, "Parse error: the body isn't JSON."))
        if isinstance(msg, list):
            return self.reply(h, 400, None, error=self.err(-32600, "Send one message per request; batches aren't supported."))
        if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
            return self.reply(h, 400, msg.get("id") if isinstance(msg, dict) else None, error=self.err(-32600, "Not a JSON-RPC 2.0 message."))
        name, mid = msg.get("method"), msg.get("id")
        if not name:   # a response from the client: this server never asks anything, so there's nothing to do
            return h.send_raw(202, b"", "text/plain")
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
        meta = params.get("_meta") if isinstance(params.get("_meta"), dict) else {}
        version, header = meta.get(PV), header_value(h.headers.get("MCP-Protocol-Version"))
        if version is not None:   # the current style: every request says its version
            if version not in SUPPORTED:
                return self.reply(h, 400, mid, error=self.err(-32022, "Unsupported protocol version",
                                                              {"supported": list(SUPPORTED), "requested": version}))
            if version in MODERN:
                if header != version:
                    return self.reply(h, 400, mid, error=self.err(-32020, "The MCP-Protocol-Version header doesn't match _meta."))
                if header_value(h.headers.get("Mcp-Method")) != name:
                    return self.reply(h, 400, mid, error=self.err(-32020, "The Mcp-Method header doesn't match the method."))
                if name == "tools/call" and header_value(h.headers.get("Mcp-Name")) != params.get("name"):
                    return self.reply(h, 400, mid, error=self.err(-32020, "The Mcp-Name header doesn't match the tool's name."))
                return self.modern(h, name, mid, params, app)
        if name != "initialize":
            if header in MODERN:
                return self.reply(h, 400, mid, error=self.err(-32020, f"Requests for {header} carry _meta with their protocol version."))
            if header and header not in LEGACY:
                return self.reply(h, 400, mid, error=self.err(-32022, "Unsupported protocol version", {"supported": list(SUPPORTED), "requested": header}))
        return self.legacy(h, name, mid, params, app, header)

    # -- 2026-07-28 ---------------------------------------------------------------------------------------------
    def modern(self, h, name, mid, params, app):
        if mid is None:   # a notification
            return h.send_raw(202, b"", "text/plain")
        stamp = {"resultType": "complete", "_meta": {"io.modelcontextprotocol/serverInfo": SERVER_INFO}}
        if name == "server/discover":
            return self.reply(h, 200, mid, dict(stamp, supportedVersions=list(SUPPORTED), capabilities={"tools": {"listChanged": False}},
                                                instructions=INSTRUCTIONS, **CACHE))
        if name == "tools/list":
            return self.reply(h, 200, mid, dict(stamp, tools=[t.spec() for t in self.toolbox.allowed(app)], **CACHE))
        if name == "tools/call":
            ok, out = self.call(params, app)
            return self.reply(h, 200, mid, dict(stamp, **out)) if ok else self.reply(h, 400, mid, error=out)
        return self.reply(h, 404, mid, error=self.err(-32601, f"Method not found: {name}"))

    # -- 2025-03-26 to 2025-11-25 -------------------------------------------------------------------------------
    def legacy(self, h, name, mid, params, app, header):
        if mid is None:   # notifications/initialized and the like
            return h.send_raw(202, b"", "text/plain")
        if name == "initialize":
            asked = params.get("protocolVersion")
            return self.reply(h, 200, mid, {"protocolVersion": asked if asked in LEGACY else LEGACY[0],
                                            "capabilities": {"tools": {"listChanged": False}}, "serverInfo": SERVER_INFO,
                                            "instructions": INSTRUCTIONS})
        if name == "ping":
            return self.reply(h, 200, mid, {})
        if name == "tools/list":
            return self.reply(h, 200, mid, {"tools": [t.spec() for t in self.toolbox.allowed(app)]})
        if name == "tools/call":
            ok, out = self.call(params, app)
            if ok and header not in ("2025-06-18", "2025-11-25"):
                out.pop("structuredContent", None)   # 2025-03-26 doesn't know it
            return self.reply(h, 200, mid, out) if ok else self.reply(h, 200, mid, error=out)
        return self.reply(h, 200, mid, error=self.err(-32601, f"Method not found: {name}"))

    def call(self, params, app):
        tool = params.get("name")
        allowed = {t.name for t in self.toolbox.allowed(app)}
        if tool not in self.toolbox.by_name:
            return False, self.err(-32602, f"Unknown tool: {tool}")
        if tool not in allowed:
            return False, self.err(-32602, f"{app['name']} isn't allowed to use {tool}. You can allow it under Integrations in the Tiiny Control Panel.")
        args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        return True, self.toolbox.call(app, tool, args)


# -- the stdio bridge ---------------------------------------------------------------------------------------------
def _gateway_port() -> int:
    """The gateway port from the panel's settings (the bridge runs as its own program)."""
    base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    try:
        return int(json.loads((base / "tiiny-ui" / "settings.json").read_text()).get("gateway_port") or 8766)
    except (OSError, ValueError, TypeError, AttributeError):
        return 8766


def _out(obj):
    sys.stdout.buffer.write(json.dumps(obj, ensure_ascii=False).encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()


def _log(text):
    sys.stderr.write(f"tiiny mcp: {text}\n")
    sys.stderr.flush()


def _with_files(msg: dict) -> dict:
    """tools/call: read *_path arguments into base64 here, on this computer."""
    params = msg.get("params") if isinstance(msg.get("params"), dict) else None
    if not params or msg.get("method") != "tools/call" or params.get("name") not in PATH_ARGS:
        return msg
    path_arg, data_arg = PATH_ARGS[params["name"]]
    args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
    if args.get(path_arg) and not args.get(data_arg):
        p = Path(os.path.expanduser(str(args[path_arg])))
        try:
            if p.stat().st_size > 50 * 1024 ** 2:
                raise ValueError("bigger than 50 MB")
            args[data_arg] = base64.b64encode(p.read_bytes()).decode()
        except (OSError, ValueError) as e:
            raise ValueError(f"Couldn't read {p}: {e}")
        if params["name"] == "tiiny_save_to_vault" and not args.get("name"):
            args["name"] = p.name
        if params["name"] == "tiiny_transcribe" and not args.get("filename"):
            args["filename"] = p.name
        args.pop(path_arg, None)
        params["arguments"] = args
    return msg


def _paths_in_schemas(result: dict) -> dict:
    """tools/list: offer file paths next to base64 for the tools that take files."""
    for t in result.get("tools") or []:
        if t.get("name") in PATH_ARGS and isinstance(t.get("inputSchema"), dict):
            path_arg, data_arg = PATH_ARGS[t["name"]]
            schema = t["inputSchema"]
            schema.setdefault("properties", {})[path_arg] = {"type": "string", "description": f"A file on this computer, instead of {data_arg}."}
            schema["required"] = [r for r in schema.get("required") or [] if r != data_arg]
    return result


def bridge_main(argv) -> int:
    ap = argparse.ArgumentParser(prog="tiiny_ui.py mcp", description="Use your Tiiny's tools from an AI assistant that starts MCP servers "
                                 "over stdio. The Tiiny Control Panel must be running; the key comes from TIINY_KEY or --key-file.")
    ap.add_argument("--url", default=os.environ.get("TIINY_MCP_URL") or "", help="the panel's MCP address (default http://127.0.0.1:<gateway port>/mcp)")
    ap.add_argument("--key-file", default="", help="a file holding the app key (instead of TIINY_KEY)")
    args = ap.parse_args(argv)
    url = args.url or f"http://127.0.0.1:{_gateway_port()}/mcp"
    key = os.environ.get("TIINY_KEY", "").strip()
    if args.key_file:
        try:
            key = Path(os.path.expanduser(args.key_file)).read_text().strip().splitlines()[0].strip()
        except (OSError, IndexError) as e:
            _log(f"couldn't read the key file: {e}")
    if not key:
        _log("no key: make one for this assistant in the Tiiny Control Panel (Integrations), then set TIINY_KEY")
    agreed = None   # the version an old-style client agreed on in initialize
    for raw in sys.stdin.buffer:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            _out({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
            continue
        if not isinstance(msg, dict):
            _out({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Send one message per line; batches aren't supported."}})
            continue
        mid, method = msg.get("id"), msg.get("method")
        try:
            msg = _with_files(msg)
        except ValueError as e:
            if mid is not None:
                _out({"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": str(e)}})
            continue
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
        meta = params.get("_meta") if isinstance(params.get("_meta"), dict) else {}
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": f"Bearer {key}"}
        if meta.get(PV):
            headers["MCP-Protocol-Version"] = str(meta[PV])
            if method:
                headers["Mcp-Method"] = encode_header(str(method))
            if method == "tools/call":
                headers["Mcp-Name"] = encode_header(str(params.get("name") or ""))
        elif agreed and method != "initialize":
            headers["MCP-Protocol-Version"] = agreed
        req = urllib.request.Request(url, data=json.dumps(msg).encode("utf-8"), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=1800) as resp:
                status, data = resp.status, resp.read()
        except urllib.error.HTTPError as e:
            status, data = e.code, e.read()
        except (OSError, ValueError) as e:
            if mid is not None:
                _out({"jsonrpc": "2.0", "id": mid, "error": {"code": -32000, "message":
                      f"The Tiiny Control Panel isn't running, or its gateway is switched off ({e}). Start it with: python3 tiiny_ui.py"}})
            continue
        if status == 202 or not data.strip():
            continue
        try:
            reply = json.loads(data)
        except ValueError:
            reply = None
        if not isinstance(reply, dict) or "jsonrpc" not in reply:   # the gateway refused before MCP (a bad key, …)
            text = (reply or {}).get("error", {}).get("message") if isinstance(reply, dict) and isinstance(reply.get("error"), dict) else data[:300].decode("utf-8", "replace")
            if mid is not None:
                _out({"jsonrpc": "2.0", "id": mid, "error": {"code": -32001 if status == 401 else -32000, "message": text or f"HTTP {status}"}})
            continue
        result = reply.get("result")
        if isinstance(result, dict):
            if method == "initialize" and result.get("protocolVersion"):
                agreed = result["protocolVersion"]
            if method == "tools/list":
                _paths_in_schemas(result)
        _out(reply)
    return 0
