#!/usr/bin/env python3
"""Add-on start: turn the options from Home Assistant's Configuration tab into the panel's settings, then start it."""
import json
import os
import sys

try:
    with open(os.environ.get("HA_OPTIONS_FILE", "/data/options.json"), encoding="utf-8") as f:
        opts = json.load(f)
except (OSError, ValueError):
    opts = {}

# Empty address = never trust the Ingress proxy: every browser signs in to the panel itself.
os.environ["TIINY_HA_INGRESS_FROM"] = "172.30.32.2" if opts.get("trust_ha_login", True) else ""
args = ["/app/bin/tiiny-panel"]
if opts.get("allow_commands"):
    args.append("--allow-commands")
if opts.get("log_requests"):
    args.append("--verbose")
for name in opts.get("public_names") or []:
    if isinstance(name, str) and name.strip():
        args += ["--public-name", name.strip()]
print("Starting:", " ".join(args), "| trust Home Assistant login:", bool(os.environ["TIINY_HA_INGRESS_FROM"]), flush=True)
if os.environ.get("HA_START_DRY_RUN"):
    sys.exit(0)
os.execv(args[0], args)
