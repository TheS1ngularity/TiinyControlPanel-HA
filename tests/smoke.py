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
DEVICE = {"state": "locked", "unlocks": 0, "good_key": 0, "logins": 0, "running": [], "starts": []}
MODELS = [{"id": "acme/chat-model", "name": "Chat model", "type": "Text Generation", "npu_usage": 9.5},
          {"id": "acme/embed-model", "name": "Embed model", "type": "Embedding", "npu_usage": 1.2}]
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
        if self.path.startswith("/api/v1/models/") and self.path.endswith("/get_progress"):
            return self.reply({"status": "loaded", "progress": 100})
        if self.path.split("?")[0] == "/api/v1/models/":
            return self.reply({"data": MODELS})
        if self.path.split("?")[0] == "/v1/models":
            return self.reply({"data": [{"id": i} for i in DEVICE["running"]]})
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
        elif self.path == "/api/v1/account/auth":
            DEVICE["logins"] += 1
            if body.get("password") == "right-password":
                return self.reply({"auth_key": "test-key", "user_info": {"user_name": "tester"}})
            self.send_response(401)
            self.send_header("Content-Length", "2")
            self.end_headers()
            return self.wfile.write(b"{}")
        elif self.path.startswith("/api/v1/models/") and self.path.endswith("/start"):
            mid = self.path[len("/api/v1/models/"):-len("/start")]
            DEVICE["starts"].append(mid)
            DEVICE["running"].append(mid)
            return self.reply({"status": "ok"})
        self.reply({"data_state": DEVICE["state"], "status": "not_auth" if DEVICE["state"] == "locked" else "ok"})


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
    shutil.copy(ADDON / "ha" / "ha-autoload.js", app / "static" / "ha-autoload.js")
    shutil.copy(ADDON / "ha" / "ha_watch.py", app / "tiinyui" / "ha_watch.py")
    subprocess.run([sys.executable, str(ADDON / "ha" / "patch_for_ha.py"), str(app)], check=True)
    subprocess.run([sys.executable, "-m", "py_compile", str(app / "tiiny_ui.py"), str(app / "tiinyui" / "gateway.py"),
                    str(app / "tiinyui" / "ha_watch.py")], check=True)
    return app


def start_panel(app: Path, work: Path, any_address: str, name: str = "", key: str = "test-key", password: str = "", autoload=(),
                address: str = "", locked: bool = True):
    name = name or any_address
    DEVICE.update(state="locked" if locked else "unlocked", unlocks=0, good_key=0, logins=0, running=[], starts=[])
    home = work / f"home-{name}"
    cfg = home / "config" / "tiiny-ui"
    cfg.mkdir(parents=True)
    (cfg / "settings.json").write_text(json.dumps({"device_address": "" if address else "127.0.0.1", "device_port": str(P_DEVICE), "api_key": key}))
    (home / "options.json").write_text(json.dumps({"auto_unlock": True, "unlock_password": password, "tiiny_address": address}))
    if autoload:
        (home / "share" / "tiiny-ui").mkdir(parents=True)
        (home / "share" / "tiiny-ui" / "ha-autoload.json").write_text(json.dumps({"selected": list(autoload)}))
    env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home / "config"), XDG_DATA_HOME=str(home / "share"),
               TIINY_UI_TLS="off", TIINY_HA_INGRESS_FROM="127.0.0.1", TIINY_HA_GATEWAY_ANY_ADDRESS=any_address,
               TIINY_HA_AUTO_UNLOCK="1", TIINY_HA_AUTO_UNLOCK_EVERY="5", TIINY_HA_AUTOLOAD_RETRY="1",
               HA_OPTIONS_FILE=str(home / "options.json"))
    log = open(work / f"panel-{name}.log", "w")
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


def wait_for(test, seconds=25):
    end = time.time() + seconds
    while time.time() < end and not test():
        time.sleep(0.3)
    return bool(test())


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
            frame.click("#ha-autoload-btn")
            page.wait_for_timeout(1500)
            boxes = frame.eval_on_selector_all("#ha-autoload input[type=checkbox]", "els => els.map(e => e.checked)")
            check(len(boxes) == 2 and any(boxes), f"the Auto-load picker lists the models with the saved choice ticked ({boxes})")
            if os.environ.get("SMOKE_SHOT"):
                page.screenshot(path=os.environ["SMOKE_SHOT"])
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
    proc = start_panel(app, work, "1", autoload=["acme/chat-model"])
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
        check(wait_for(lambda: DEVICE["starts"] == ["acme/chat-model"]), "after the unlock the chosen model is loaded",
              f"starts {DEVICE['starts']}")
        code, text = call("GET", base + "/api/ha/autoload", headers={"X-Tiiny-Token": token})
        got = json.loads(text) if code == 200 else {}
        check(got.get("selected") == ["acme/chat-model"] and len(got.get("models") or []) == 2 and got.get("auto_unlock") is True,
              "the picker gets the model list and the saved choice", f"HTTP {code} {text[:200]}")
        code, text = call("POST", base + "/api/ha/autoload", {"selected": ["acme/chat-model", "acme/embed-model"], "load_now": True},
                          {"X-Tiiny-Token": token})
        check(code == 200 and wait_for(lambda: DEVICE["starts"] == ["acme/chat-model", "acme/embed-model"]),
              '"Save and load now" loads what is missing, and nothing twice', f"HTTP {code} starts {DEVICE['starts']}")
        check(call("POST", base + "/api/ha/autoload", {"selected": "x"}, {"X-Tiiny-Token": token})[0] == 400, "a malformed choice is refused")
        check('static/ha-autoload.js' in html, "the page loads the picker")
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

    print("Run 3: the saved key is refused, the password option is filled in", flush=True)
    proc = start_panel(app, work, "1", name="password", key="stale-key", password="right-password", autoload=["acme/embed-model"])
    try:
        check(wait_for(lambda: DEVICE["state"] == "unlocked"), "a refused key falls back to the password and unlocks",
              f"logins {DEVICE['logins']} unlock calls {DEVICE['unlocks']}")
        check(DEVICE["logins"] == 1 and DEVICE["good_key"] == 1, "one log in, then the new key is used", f"logins {DEVICE['logins']}")
        check(wait_for(lambda: DEVICE["starts"] == ["acme/embed-model"]), "the chosen model is loaded after a password unlock")
        cli = list((work / "home-password").rglob("config.json"))
        check(any('"test-key"' in f.read_text() for f in cli), "the new key is saved for next time")
    finally:
        proc.terminate()
        proc.wait(timeout=20)
    logtext = (work / "panel-password.log").read_text()
    check("right-password" not in logtext and "stale-key" not in logtext and "test-key" not in logtext, "neither password nor keys are in the log")
    check("The Tiiny answered: HTTP 200, status=not_auth" in logtext, "the log says what the Tiiny answered when it refused")

    print("Run 4: the saved key and the password are both refused", flush=True)
    proc = start_panel(app, work, "1", name="wrong", key="stale-key", password="wrong-password")
    try:
        wait_for(lambda: DEVICE["logins"] >= 1)
        time.sleep(12)
        check(DEVICE["logins"] == 1 and DEVICE["state"] == "locked", "a refused password is tried once, not again",
              f"logins {DEVICE['logins']}")
        check(DEVICE["unlocks"] == 1, "the refused key is not sent again straight away", f"unlock calls {DEVICE['unlocks']}")
    finally:
        proc.terminate()
        proc.wait(timeout=20)

    print("Run 5: a new install with the address and password in the add-on options, Tiiny already unlocked", flush=True)
    proc = start_panel(app, work, "1", name="fresh", key="", password="right-password", address="127.0.0.1", locked=False,
                       autoload=["acme/chat-model"])
    try:
        check(wait_for(lambda: DEVICE["logins"] == 1), "with no saved key the add-on logs in with the password", f"logins {DEVICE['logins']}")
        check(wait_for(lambda: any('"test-key"' in f.read_text() for f in (work / "home-fresh").rglob("config.json"))),
              "the key is saved, at the address from the options")
        time.sleep(7)
        check(DEVICE["logins"] == 1 and DEVICE["unlocks"] == 0, "it logs in once and sends no unlock to an unlocked Tiiny",
              f"logins {DEVICE['logins']} unlock calls {DEVICE['unlocks']}")
        check(DEVICE["starts"] == [], "models are not loaded just because the add-on started", f"starts {DEVICE['starts']}")
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
