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
  4. index.html loads its files by relative address, plus static/ha-ingress.js, which prefixes the
     panel's requests with the Ingress path.
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

index = app / "static" / "index.html"
text = index.read_text(encoding="utf-8")
if '"/static/' not in text or '<script src="/static/theme.js"></script>' not in text:
    sys.exit("patch_for_ha: index.html doesn't look like expected")
text = text.replace('<script src="/static/theme.js"></script>',
                    '<script src="/static/ha-ingress.js"></script>\n<script src="/static/theme.js"></script>')
text = text.replace('="/static/', '="static/')
index.write_text(text, encoding="utf-8")
print("patch_for_ha: done")
