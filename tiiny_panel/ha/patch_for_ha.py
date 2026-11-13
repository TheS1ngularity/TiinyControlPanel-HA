#!/usr/bin/env python3
"""Home Assistant add-on build step: small, checked edits to the Tiiny Control Panel so it works inside
Home Assistant (Ingress). Every edit must match exactly once, otherwise the build stops: after a panel
update that moves this code, fix the edit here instead of shipping a half-patched panel.

What changes:
  1. A request that Home Assistant's Ingress proxy forwards (from 172.30.32.2, with X-Ingress-Path) skips the
     Host/Origin checks and counts as a signed-in device with full access: Home Assistant's own login (admin
     only, see config.yaml) already decided who gets in.
  2. The page may be framed by its own origin (Home Assistant shows add-ons in a frame).
  3. Request bodies that Ingress sends in chunks are collected before the panel reads them.
  4. Optional (add-on option): the gateway's network listener accepts requests addressed to any numeric
     address, so apps on other machines can reach it through Home Assistant's address.
  5. Optional: unlock the Tiiny automatically after it restarts, and load chosen models afterwards. The code is
     in ha_watch.py (copied to tiinyui/); here it is only started and given two routes for its picker.
  6. index.html loads its files by relative address, plus static/ha-ingress.js, which prefixes the
     panel's requests with the Ingress path, and static/ha-autoload.js, the picker.
"""
import sys
from pathlib import Path

app = Path(sys.argv[1])


def edit(path: Path, old: str, new: str, count: int = 1):
    text = path.read_text(encoding="utf-8")
    found = text.count(old)
    if found != count:
        sys.exit(f"patch_for_ha: expected {count} match(es) in {path.name}, found {found}, for:\n{old}")
    path.write_text(text.replace(old, new), encoding="utf-8")


ui = app / "tiiny_ui.py"

edit(ui, '''CSP = ("default-src 'self'; script-src 'self'; "''',
     '''HA_INGRESS_FROM = os.environ.get("TIINY_HA_INGRESS_FROM", "172.30.32.2")


def ha_ingress(handler) -> bool:
    """Is this request forwarded by Home Assistant's Ingress proxy? Only the Supervisor has that address."""
    return bool(HA_INGRESS_FROM) and str(handler.client_address[0]) == HA_INGRESS_FROM and bool(handler.headers.get("X-Ingress-Path"))


def ha_unchunk(handler, limit=4 << 30):
    """Home Assistant's Ingress proxy streams request bodies in chunks, without a Content-Length. The panel reads
    bodies by Content-Length, so collect the chunks first (in memory up to 8 MB, then in a temporary file)."""
    if "chunked" not in (handler.headers.get("Transfer-Encoding") or "").lower():
        return
    import tempfile
    buf, total, rfile = tempfile.SpooledTemporaryFile(max_size=8 << 20), 0, handler.rfile
    while True:
        size = int(rfile.readline(1024).split(b";")[0].strip() or b"0", 16)
        if size == 0:
            while rfile.readline(8192) not in (b"\\r\\n", b"\\n", b""):
                pass   # trailers
            break
        total += size
        if total > limit:
            raise BadRequest("Request body is too large")
        left = size
        while left:
            part = rfile.read(min(1 << 20, left))
            if not part:
                raise BadRequest("The request body ended early")
            buf.write(part)
            left -= len(part)
        rfile.readline(8)   # the line end after each chunk
    buf.seek(0)
    handler.rfile = buf
    del handler.headers["Transfer-Encoding"]
    del handler.headers["Content-Length"]
    handler.headers["Content-Length"] = str(total)
    handler.close_connection = True


CSP = ("default-src 'self'; script-src 'self'; "''')

edit(ui, '''       "frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
FILE_CSP''', '''       "frame-ancestors 'self'; base-uri 'none'; form-action 'none'")
FILE_CSP''')

edit(ui, '''            host = (self.headers.get("Host") or "").strip().lower()
            if not self.host_ok(host):''', '''            host = (self.headers.get("Host") or "").strip().lower()
            ingress = ha_ingress(self)
            if ingress:
                ha_unchunk(self)
            if not ingress and not self.host_ok(host):''')

edit(ui, '''            if self.server_mode():  # server mode: every device signs in, with full or limited access''',
     '''            if ingress:  # opened inside Home Assistant, which already checked the login
                self.device = {"id": "ha-ingress", "name": "Home Assistant", "role": "owner"}
            elif self.server_mode():  # server mode: every device signs in, with full or limited access''')

edit(ui, '''            if method != "GET" and origin and self.server.check_host and not self.host_ok(''',
     '''            if method != "GET" and origin and not ingress and self.server.check_host and not self.host_ok(''')

edit(ui, '''from tiinyui.settings import Settings
''', '''from tiinyui.settings import Settings
from tiinyui import ha_watch
''')

edit(ui, '''    DEVCONN = DeviceConn(SETTINGS)
''', '''    DEVCONN = DeviceConn(SETTINGS)
    ha_watch.start(DEVCONN, SETTINGS)
''')

# The picker for "load these models after an unlock" (static/ha-autoload.js) talks to these two routes.
edit(ui, '''        ("POST", r"/api/models/borrowed", "api_models_borrowed"),
''', '''        ("POST", r"/api/models/borrowed", "api_models_borrowed"),
        ("GET", r"/api/ha/autoload", "api_ha_autoload"),
        ("POST", r"/api/ha/autoload", "api_ha_autoload_set"),
''')

edit(ui, '''    def api_models_borrowed(self, q):
''', '''    def api_ha_autoload(self, q):
        self.send_json(200, ha_watch.status(DEVCONN))

    def api_ha_autoload_set(self, q):
        self.send_json(200, ha_watch.update(DEVCONN, self.read_json()))

    def api_models_borrowed(self, q):
''')

edit(ui, '''                 "/api/apps", "/api/gateway")''', '''                 "/api/apps", "/api/gateway", "/api/ha/")''')

gw = app / "tiinyui" / "gateway.py"

edit(gw, '''MAX_BODY = 100 * 1024 ** 2''', '''def ha_numeric_host(server, host: str) -> bool:
    """Add-on option "Gateway: accept any numeric address". An add-on has its own internal address, while apps on
    other machines reach the gateway through Home Assistant's address, so the Host they send never matches the one
    the gateway listens on. With the option on, the network listener also accepts a Host that is a plain IP address.
    A website attacking through DNS rebinding has to send a name, so it is still refused."""
    import os
    if not getattr(server, "lan", False) or os.environ.get("TIINY_HA_GATEWAY_ANY_ADDRESS") != "1":
        return False
    host = (host or "").strip()
    if host.startswith("["):
        name = host[1:host.find("]")] if "]" in host else ""
    else:
        name = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        return False


MAX_BODY = 100 * 1024 ** 2''')

edit(gw, '''            if host not in self.server.hosts:''',
     '''            if host not in self.server.hosts and not ha_numeric_host(self.server, host):''')

index = app / "static" / "index.html"
text = index.read_text(encoding="utf-8")
if '"/static/' not in text or '<script src="/static/theme.js"></script>' not in text:
    sys.exit("patch_for_ha: index.html doesn't look like expected")
text = text.replace('<script src="/static/theme.js"></script>',
                    '<script src="/static/ha-ingress.js"></script>\n<script src="/static/theme.js"></script>')
if "</body>" not in text:
    sys.exit("patch_for_ha: index.html has no </body>")
text = text.replace("</body>", '<script defer src="/static/ha-autoload.js"></script>\n</body>', 1)
text = text.replace('="/static/', '="static/')
index.write_text(text, encoding="utf-8")
print("patch_for_ha: done")
