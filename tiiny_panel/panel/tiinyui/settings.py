"""Panel settings, stored in ~/.config/tiiny-ui/settings.json (mode 600)."""

from __future__ import annotations

import json
import threading
from pathlib import Path

from .common import atomic_write, mask

# Every setting and its default. Strings are free text; the rest keep their JSON type.
DEFAULTS = {
    "tiiny_bin": "",
    "cli_config": "",
    "device_address": "",
    "device_port": "",
    "api_key": "",
    "idle_unload": False,         # unload models nobody used for idle_minutes
    "idle_minutes": 30,
    "keep_loaded": [],            # model ids the idle watcher never unloads
    "lan_enabled": False,         # second listener for phones and other devices
    "lan_port": 0,                # 0 = same port as the main listener
    "npu_footprints": {},         # model id -> NPU memory (MB) the panel measured when it loaded
    "search_engine": "duckduckgo",  # agent web search: duckduckgo | brave | searxng (see websearch.py)
    "search_brave_key": "",       # Brave Search API key (secret: never sent to the page)
    "search_searxng_url": "",     # your SearXNG server, e.g. http://192.168.1.20:8080
    "agent_tools_off": [],        # agent tools switched off under System → Agent tools (tool names, or "history")
    "decision_model": "",         # the decision model features use ("" = a loaded one, else the smallest; see decide.py)
    "decisions_off": [],          # decision features switched off under System → Decision models (decide.FEATURES keys)
    "update_check_daily": False,  # ask GitHub once a day whether a new panel version is out (selfupdate.py); off until you switch it on
    "gateway_enabled": True,      # the gateway for other apps on this computer, at 127.0.0.1:gateway_port (gateway.py); apps need a key
    "gateway_port": 8766,
    "gateway_lan": False,         # also listen on this computer's network address, for apps on other computers
    "gateway_keyless_ollama": False,  # let Ollama apps that can't send a key use chat and embeddings, from this computer only
}


class Settings:
    FIELDS = tuple(DEFAULTS)

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        self.overrides = {}
        self.data = json.loads(json.dumps(DEFAULTS))
        try:
            loaded = json.loads(path.read_text())
            for k, default in DEFAULTS.items():
                if k in loaded and isinstance(loaded[k], type(default)):
                    self.data[k] = loaded[k]
        except (OSError, ValueError, AttributeError):
            pass

    def override(self, key: str, value):
        """Use a value for this run only (from a command-line option); it isn't saved."""
        with self.lock:
            self.overrides[key] = value

    def get(self, key: str):
        with self.lock:
            v = self.overrides[key] if key in self.overrides else self.data.get(key, DEFAULTS.get(key))
            return json.loads(json.dumps(v)) if isinstance(v, (list, dict)) else v

    def update(self, changes: dict) -> dict:
        """Apply known keys with the right type; returns the keys that changed."""
        applied = {}
        with self.lock:
            for k, v in changes.items():
                default = DEFAULTS.get(k)
                if default is None:
                    continue
                if isinstance(default, bool):
                    v = bool(v)
                elif isinstance(default, int):
                    try:
                        v = int(v)
                    except (TypeError, ValueError):
                        continue
                elif isinstance(default, str):
                    if not isinstance(v, str):
                        continue
                    v = v.strip()
                elif isinstance(default, list):
                    if not isinstance(v, list):
                        continue
                    v = [str(x) for x in v][:200]
                elif isinstance(default, dict):
                    if not isinstance(v, dict):
                        continue
                    v = {str(name)[:300]: int(mb) for name, mb in list(v.items())[:300]
                         if isinstance(mb, (int, float)) and not isinstance(mb, bool) and 0 < mb < 10_000_000}
                if self.data.get(k) != v:
                    self.data[k] = v
                    applied[k] = v
            snapshot = json.dumps(self.data, indent=2)
        atomic_write(self.path, snapshot)
        return applied

    def public(self) -> dict:
        with self.lock:
            d = json.loads(json.dumps(self.data))
        key = d.pop("api_key")
        d["api_key_set"] = bool(key)
        d["api_key_hint"] = mask(key)
        brave = d.pop("search_brave_key")
        d["search_brave_key_set"] = bool(brave)
        d["search_brave_key_hint"] = mask(brave)
        return d
