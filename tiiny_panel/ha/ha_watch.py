"""Home Assistant add-on part (not in the upstream Tiiny Control Panel): keep the Tiiny ready without anyone
logging in by hand.

One background check, once a minute:
  1. Unlock (add-on option "Unlock the Tiiny automatically"). After a restart the Tiiny keeps its data locked. The
     check sends the key saved at your last log in. If there is no saved key, or the Tiiny refuses it, and the add-on
     option "Tiiny password" is filled in, it logs in with the password once, saves the new key and unlocks with it.
  2. Load models (chosen in the panel, button "Auto-load"). Once the Tiiny is unlocked again after having been
     locked or unreachable, the chosen models are loaded one after the other.

The key and the password are never written to the log.
"""
import json
import os
import threading
import time

from . import device
from .common import BadRequest, DeviceError, atomic_write, data_dir

KEY_TRIES = 3            # then stop sending the saved key until the Tiiny has been seen unlocked
MAX_MODELS = 12
WAKE = threading.Event()
STATUS = {"last": "", "at": 0, "busy": False}
_load_now = threading.Event()


def log(text: str, remember: bool = False):
    print(text, flush=True)
    if remember:
        STATUS.update(last=text, at=int(time.time()))


def options() -> dict:
    """The add-on's options. Read when needed, so the password never sits in the environment of the panel's
    terminals and commands."""
    try:
        with open(os.environ.get("HA_OPTIONS_FILE", "/data/options.json"), encoding="utf-8") as f:
            o = json.load(f)
        return o if isinstance(o, dict) else {}
    except (OSError, ValueError):
        return {}


def auto_unlock_on() -> bool:
    return os.environ.get("TIINY_HA_AUTO_UNLOCK") == "1"


def password() -> str:
    p = options().get("unlock_password")
    return p if isinstance(p, str) and 0 < len(p) <= 256 else ""


def store_path():
    return data_dir() / "ha-autoload.json"


def selected() -> list:
    try:
        ids = json.loads(store_path().read_text(encoding="utf-8")).get("selected")
    except (OSError, ValueError, AttributeError):
        return []
    return [i for i in ids if isinstance(i, str) and i][:MAX_MODELS] if isinstance(ids, list) else []


def data_state(info: dict, key: str):
    """"locked", "unlocked", "" (the Tiiny answered without saying) or None (no answer at all)."""
    r = device.device_json(info, "auth", "POST", "/api/v1/connect", body={"auth_key": key} if key else {}, timeout=15)
    if r.get("status") is None:
        return None
    return str(r["json"].get("data_state") or "") if isinstance(r.get("json"), dict) else ""


def said(r: dict) -> str:
    """What the Tiiny answered, for the log: status and message fields only, never a key."""
    data = r.get("json") if isinstance(r.get("json"), dict) else {}
    parts = [f"HTTP {r.get('status')}" if r.get("status") is not None else "no answer"]
    for k in ("status", "error_code", "msg", "message", "detail", "error"):
        v = data.get(k)
        if isinstance(v, (str, int)) and not isinstance(v, bool) and str(v).strip():
            parts.append(f"{k}={str(v).strip()[:120]}")
    if r.get("status") is None and r.get("error"):
        parts.append(str(r["error"])[:160])
    return ", ".join(parts)


def unlock(info: dict, key: str):
    """Send the key. Returns (state afterwards, what the Tiiny answered)."""
    r = device.device_json(info, "auth", "POST", "/api/v1/account/unlock_with_auth_key", body={"auth_key": key}, timeout=60)
    return data_state(info, key), said(r)


def password_login(devconn, settings, pw: str) -> str:
    """Log in with the password like the panel's Log in button: the Tiiny answers with a new key, which is saved
    where the panel and Tiiny's tool both read it. Raises BadRequest when the Tiiny refuses the password."""
    info = devconn.resolve()
    got = device.grant_key(info, pw)
    device.save_cli_key(devconn.cli_config_path(), got["key"], info["address"])
    if settings.get("api_key"):   # a key typed under System → Settings would win over the new one
        settings.update({"api_key": ""})
    return got["key"]


def apply_address(settings):
    """Add-on option "Tiiny address": when filled in, it is the address the panel uses (set at every start)."""
    addr = options().get("tiiny_address")
    addr = addr.strip() if isinstance(addr, str) else ""
    if not addr or len(addr) > 255 or any(c.isspace() or c in "/?#@" for c in addr):
        if addr:
            log("Tiiny address: the add-on option should be an address like 192.168.1.50. Ignored.")
        return
    if settings.get("device_address") != addr:
        settings.update({"device_address": addr})
        log("Tiiny address: taken from the add-on options.")


def load_models(devconn, ids: list):
    """Wait until the Tiiny's services answer (they need a minute after an unlock), then load each chosen model."""
    STATUS["busy"] = True
    try:
        info, models, err = devconn.resolve(), None, ""
        for _ in range(30):
            try:
                models = {m["id"] for m in device.list_models(info)}
                break
            except (DeviceError, OSError) as e:
                err = str(e)
                time.sleep(float(os.environ.get("TIINY_HA_AUTOLOAD_RETRY") or 10))
                info = devconn.resolve()
        if models is None:
            return log(f"Auto-load: the Tiiny's model service didn't answer in time ({err[:160]}). Nothing was loaded.", True)
        done, failed = [], []
        for mid in ids:
            short = mid.split("/")[-1]
            if mid not in models:
                failed.append(f"{short} (not on the Tiiny any more)")
                continue
            try:
                log(f"Auto-load: loading {short}…")
                device.ensure_loaded(info, mid, timeout=900)
                done.append(short)
            except (DeviceError, BadRequest, OSError) as e:
                failed.append(f"{short} ({str(e)[:160]})")
        log("Auto-load: " + (f"loaded {', '.join(done)}." if done else "nothing loaded.")
            + (f" Failed: {'; '.join(failed)}." if failed else ""), True)
    finally:
        STATUS["busy"] = False


def status(devconn) -> dict:
    """For the picker in the panel."""
    out = {"selected": selected(), "models": [], "error": "", "auto_unlock": auto_unlock_on(), "password_set": bool(password()),
           "last": STATUS["last"], "last_at": STATUS["at"], "busy": STATUS["busy"]}
    try:
        out["models"] = [{"id": m["id"], "name": str(m.get("name") or m["id"].split("/")[-1]), "type": str(m.get("type") or ""),
                          "npu_usage": m.get("npu_usage") if isinstance(m.get("npu_usage"), (int, float)) else None}
                         for m in device.list_models(devconn.resolve())]
    except (DeviceError, OSError) as e:
        out["error"] = str(e)
    return out


def update(devconn, body: dict) -> dict:
    ids = body.get("selected")
    if ids is not None:
        if not isinstance(ids, list) or len(ids) > MAX_MODELS or not all(isinstance(i, str) and 0 < len(i) <= 300 for i in ids):
            raise BadRequest(f"Choose up to {MAX_MODELS} models.")
        atomic_write(store_path(), json.dumps({"selected": list(dict.fromkeys(ids))}, indent=2))
    if body.get("load_now"):
        if not selected():
            raise BadRequest("Tick at least one model first.")
        _load_now.set()
        WAKE.set()
    return status(devconn)


def start(devconn, settings):
    apply_address(settings)
    try:
        every = max(5, int(os.environ.get("TIINY_HA_AUTO_UNLOCK_EVERY") or 60))
    except ValueError:
        every = 60

    def loop():
        key_fails, next_key_try, pw_tried, pw_refused, pending = 0, 0.0, False, False, False
        WAKE.wait(min(30, every))
        while True:
            WAKE.clear()
            try:
                auto, want, now = auto_unlock_on(), selected(), _load_now.is_set()
                info = devconn.resolve() if (auto or want) else {}
                if info.get("address"):
                    key = info.get("key") or ""
                    state = data_state(info, key)
                    if state is None:
                        pending = True          # switched off or restarting: load the models again once it is back
                    elif state == "locked":
                        pending = True
                        if auto:
                            if key and key_fails < KEY_TRIES and time.time() >= next_key_try:
                                log("Auto-unlock: your Tiiny is locked. Unlocking it with the saved key.")
                                state, why = unlock(info, key)
                                if state == "locked":
                                    key_fails += 1
                                    next_key_try = time.time() + every * 15
                                    log(f"Auto-unlock: it is still locked (attempt {key_fails} of {KEY_TRIES}). The Tiiny answered: {why}."
                                        + (" Giving up on the saved key: log in from the panel's Account page." if key_fails >= KEY_TRIES else ""))
                                else:
                                    log("Auto-unlock: unlocked.")
                            pw = password()
                            if state == "locked" and pw and not pw_tried and not pw_refused:
                                pw_tried = True
                                log("Auto-unlock: logging in with the password from the add-on options.")
                                try:
                                    state, why = unlock(devconn.resolve(), password_login(devconn, settings, pw))
                                    if state == "locked":
                                        log(f"Auto-unlock: the password was accepted but the Tiiny is still locked. It answered: {why}.")
                                    else:
                                        key_fails, next_key_try = 0, 0.0
                                        log("Auto-unlock: unlocked with a new key.")
                                except BadRequest as e:
                                    pw_refused = True
                                    log(f"Auto-unlock: {e} Not trying the password again until the add-on restarts.")
                                finally:
                                    pw = None
                    elif auto and not key and not pw_refused and password():
                        log("Auto-unlock: no key is saved yet. Logging in with the password from the add-on options.")
                        try:
                            password_login(devconn, settings, password())
                            log("Auto-unlock: logged in, the key is saved.")
                        except BadRequest as e:
                            pw_refused = True
                            log(f"Auto-unlock: {e} Not trying the password again until the add-on restarts.")
                    if state and state != "locked":
                        key_fails, next_key_try, pw_tried = 0, 0.0, False
                        if (pending or now) and want:
                            _load_now.clear()
                            load_models(devconn, want)
                        pending = False
                    elif now:
                        _load_now.clear()
                        log("Auto-load: the Tiiny is locked or not answering, so nothing was loaded.", True)
            except Exception as e:  # noqa: BLE001
                log(f"Auto-unlock: {e}")
            WAKE.wait(every)

    threading.Thread(target=loop, daemon=True, name="ha-watch").start()
