#!/usr/bin/env python3
"""End-to-end check of the Home Assistant edits, without Home Assistant and without a Tiiny.

It builds the panel the way the Dockerfile does (copy, add the shim, run patch_for_ha.py), starts it, and puts two
stand-ins around it:
  - a proxy that behaves like Home Assistant Ingress: strips the path prefix, adds X-Ingress-Path, and sends request
    bodies in chunks without a Content-Length;
  - a fake Tiiny that starts out locked.
Then it checks each edit: sign-in trust, saving through chunked bodies, the gateway's host check, auto-unlock, and
(with --browser) that every page loads inside a frame with no request escaping the prefix.

Run: python3 tests/smoke.py [--browser] [--panel DIR]      (--browser needs: pip install playwright; playwright install chromium)
"""
import argparse
import http.client
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ADDON = ROOT / "tiiny_panel"
PREFIX = "/api/hassio_ingress/TESTTOKEN"
P_PANEL, P_GATEWAY, P_PROXY, P_DEVICE = 18765, 18766, 18000, 18080
DEVICE = {"state": "locked", "unlocks": 0, "good_key": 0}
OUTSIDE = []          # requests the page made outside the Ingress prefix
FAILS = []


def check(ok, what, detail=""):
    print(("  ok    " if ok else "  FAIL  ") + what + (f"  [{detail}]" if detail and not ok else ""), flush=True)
    if not ok:
        FAILS.append(what)


class FakeTiiny(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, obj):
        out = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_GET(self):
        self.reply({})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            body = {}
        if self.path == "/api/v1/account/unlock_with_auth_key":
            DEVICE["unlocks"] += 1
            if body.get("auth_key") == "test-key":
                DEVICE["good_key"] += 1
                DEVICE["state"] = "unlocked"
        self.reply({"data_state": DEVICE["state"]})


class FakeIngress(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *a):
        pass

    def handle_any(self):
        if self.path == "/":   # stands in for Home Assistant's own page, which shows the add-on in a frame
            page = f'<!doctype html><title>HA</title><iframe id="f" src="{PREFIX}/" style="width:100%;height:95vh"></iframe>'.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(page)))
            self.end_headers()
            self.wfile.write(page)
            return
        if not self.path.startswith(PREFIX + "/"):
            if self.path != "/favicon.ico":
                OUTSIDE.append(f"{self.command} {self.path}")
            self.send_response(404)
            self.end_headers()
            return
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else None
        hdrs = {k: v for k, v in self.headers.items() if k.lower() not in ("connection", "content-length")}
        hdrs.update({"Host": "homeassistant.example", "X-Ingress-Path": PREFIX, "X-Forwarded-Proto": "https"})
        conn = http.client.HTTPConnection("127.0.0.1", P_PANEL, timeout=120)
        if body is not None:
            conn.request(self.command, self.path[len(PREFIX):], iter([body[:7], body[7:]]), hdrs, encode_chunked=True)
        else:
            conn.request(self.command, self.path[len(PREFIX):], None, hdrs)
        r = conn.getresponse()
        self.send_response(r.status)
        for k, v in r.getheaders():
            if k.lower() not in ("connection", "transfer-encoding"):
                self.send_header(k, v)
        self.end_headers()
        try:
            while True:
                chunk = r.read1(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except OSError:
            pass

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = handle_any


def serve(port, handler):
    srv = ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()


def call(method, url, body=None, headers=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def build(panel_src: Path, work: Path) -> Path:
    app = work / "app"
    app.mkdir()
    shutil.copy(panel_src / "tiiny_ui.py", app)
    shutil.copytree(panel_src / "tiinyui", app / "tiinyui")
    shutil.copytree(panel_src / "static", app / "static")
    shutil.copy(ADDON / "ha" / "ha-ingress.js", app / "static" / "ha-ingress.js")
    subprocess.run([sys.executable, str(ADDON / "ha" / "patch_for_ha.py"), str(app)], check=True)
    subprocess.run([sys.executable, "-m", "py_compile", str(app / "tiiny_ui.py"), str(app / "tiinyui" / "gateway.py")], check=True)
    return app


def start_panel(app: Path, work: Path, any_address: str):
    home = work / f"home-{any_address}"
    cfg = home / "config" / "tiiny-ui"
    cfg.mkdir(parents=True)
    (cfg / "settings.json").write_text(json.dumps({"device_address": "127.0.0.1", "device_port": str(P_DEVICE), "api_key": "test-key"}))
    env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home / "config"), XDG_DATA_HOME=str(home / "share"),
               TIINY_UI_TLS="off", TIINY_HA_INGRESS_FROM="127.0.0.1", TIINY_HA_GATEWAY_ANY_ADDRESS=any_address,
               TIINY_HA_AUTO_UNLOCK="1", TIINY_HA_AUTO_UNLOCK_EVERY="5")
    log = open(work / f"panel-{any_address}.log", "w")
    proc = subprocess.Popen([sys.executable, str(app / "tiiny_ui.py"), "--server", "--no-browser", "--port", str(P_PANEL),
                             "--gateway-port", str(P_GATEWAY)], env=env, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(60):
        try:
            if call("GET", f"http://127.0.0.1:{P_PANEL}/__tiiny__")[0] == 200:
                return proc
        except OSError:
            time.sleep(0.5)
    proc.kill()
    sys.exit("The panel didn't start. See " + log.name)


def gateway_status(base, token, host):
    """Status the gateway's network listener gives a request whose Host header is `host` (401 = let in, needs a key)."""
    code, text = call("POST", base + "/api/gateway", {"lan": True}, {"X-Tiiny-Token": token})
    lan = (json.loads(text).get("lan") or {}) if code == 200 else {}
    if not lan.get("running"):
        return None, f"network listener not running: {lan.get('error') or text[:120]}"
    addr = lan["url"].split("//", 1)[1]
    conn = http.client.HTTPConnection(addr.rsplit(":", 1)[0], int(addr.rsplit(":", 1)[1]), timeout=10)
    conn.request("GET", "/v1/models", headers={"Host": host or addr})
    return conn.getresponse().status, addr


def browser_pass():
    from playwright.sync_api import sync_playwright
    bad = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 1300, "height": 850})
        page.on("response", lambda r: bad.append(f"{r.status} {r.request.method} {r.url.split(str(P_PROXY), 1)[-1]}")
                if r.status in (401, 403, 404) and "favicon.ico" not in r.url else None)
        page.goto(f"http://127.0.0.1:{P_PROXY}/")
        page.wait_for_timeout(4000)
        frame = next((f for f in page.frames if "hassio_ingress" in f.url), None)
        check(frame is not None and "Tiiny" in (frame.title() if frame else ""), "the panel shows inside a frame")
        if frame:
            routes = frame.eval_on_selector_all("#nav a", "els => els.map(a => a.getAttribute('href'))")
            check(len(routes) >= 10, f"the menu lists its pages ({len(routes)})")
            for r in routes:
                frame.evaluate("h => { location.hash = h; }", r)
                page.wait_for_timeout(600)
            page.wait_for_timeout(1000)
        b.close()
    check(not OUTSIDE, "no request left the Ingress prefix", "; ".join(sorted(set(OUTSIDE))[:6]))
    check(not bad, "no page request was refused or missing (401/403/404)", "; ".join(sorted(set(bad))[:6]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--browser", action="store_true", help="also load every page in a headless browser")
    ap.add_argument("--panel", default=str(ADDON / "panel"), help="panel source to test (default: tiiny_panel/panel)")
    args = ap.parse_args()
    work = Path(tempfile.mkdtemp(prefix="tiiny-ha-test-"))
    print("Building the patched panel…", flush=True)
    app = build(Path(args.panel), work)
    serve(P_DEVICE, FakeTiiny)
    serve(P_PROXY, FakeIngress)
    base = f"http://127.0.0.1:{P_PROXY}{PREFIX}"

    print("Run 1: all add-on options on", flush=True)
    proc = start_panel(app, work, "1")
    try:
        code, html = call("GET", base + "/")
        check(code == 200 and "static/ha-ingress.js" in html, "through Ingress the page opens without a sign-in", f"HTTP {code}")
        check('="/static/' not in html, "the page loads its files by relative address")
        token = html.split('name="tiiny-token" content="')[1].split('"')[0] if "tiiny-token" in html else ""
        check(call("GET", f"http://127.0.0.1:{P_PANEL}/")[0] == 401, "opened directly, the panel still asks for a sign-in")
        code, text = call("POST", base + "/api/settings", {"idle_minutes": 45}, {"X-Tiiny-Token": token})
        saved = code == 200 and json.loads(text).get("settings", {}).get("idle_minutes") == 45
        check(saved, "a setting sent as a chunked body is saved", f"HTTP {code}")
        code, text = call("GET", base + "/api/health", headers={"X-Tiiny-Token": token})
        check(code == 200 and json.loads(text).get("role") == "owner", "an Ingress visitor has full access")
        for host, want, what in (("", 401, "its own address"), ("10.9.8.7:%d" % P_GATEWAY, 401, "another numeric address"),
                                 ("[fd00::1]:%d" % P_GATEWAY, 401, "an IPv6 address"), ("evil.example:%d" % P_GATEWAY, 403, "a host name")):
            got, info = gateway_status(base, token, host)
            check(got == want, f"gateway, request addressed to {what}: {'let in' if want == 401 else 'refused'}", f"got {got} {info}")
        for _ in range(40):
            if DEVICE["good_key"]:
                break
            time.sleep(0.5)
        check(DEVICE["good_key"] == 1 and DEVICE["state"] == "unlocked", "a locked Tiiny is unlocked automatically with the saved key",
              f"unlock calls {DEVICE['unlocks']}")
        time.sleep(7)
        check(DEVICE["unlocks"] == 1, "an unlocked Tiiny is left alone", f"unlock calls {DEVICE['unlocks']}")
        if args.browser:
            browser_pass()
    finally:
        proc.terminate()
        proc.wait(timeout=20)

    print('Run 2: "Gateway: accept any numeric address" off', flush=True)
    proc = start_panel(app, work, "0")
    try:
        _, html = call("GET", base + "/")
        token = html.split('name="tiiny-token" content="')[1].split('"')[0]
        got, info = gateway_status(base, token, "10.9.8.7:%d" % P_GATEWAY)
        check(got == 403, "gateway, request addressed to another numeric address: refused, as upstream", f"got {got} {info}")
        got, info = gateway_status(base, token, "")
        check(got == 401, "gateway, request addressed to its own address: let in", f"got {got} {info}")
    finally:
        proc.terminate()
        proc.wait(timeout=20)

    if FAILS:
        print(f"\n{len(FAILS)} check(s) failed. Panel logs: {work}")
        sys.exit(1)
    print("\nAll checks passed.")
    shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
