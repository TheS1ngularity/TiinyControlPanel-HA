#!/usr/bin/env python3
"""Replace the copy of the Tiiny Control Panel in tiiny_panel/panel/ with another release of it.

  python3 tools/update_panel.py --source /path/to/tiiny-control-panel --version 1.5.0

It copies only what the add-on ships, sets the add-on version to <panel version>-ha1 and adds a changelog line.
It does not check that the Home Assistant edits still apply: run tests/smoke.py afterwards.
"""
import argparse
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ADDON = ROOT / "tiiny_panel"
FILES = ("tiiny_ui.py", "LICENSE", "THIRD_PARTY_NOTICES.md")
DIRS = ("tiinyui", "static")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="a checkout of the upstream panel at the release to ship")
    ap.add_argument("--version", required=True, help="that release's version, like 1.5.0")
    args = ap.parse_args()
    src, version = Path(args.source), args.version.lstrip("v")
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        sys.exit(f"Not a version like 1.5.0: {args.version}")
    init = (src / "tiinyui" / "__init__.py").read_text(encoding="utf-8")
    found = re.search(r'^VERSION = "([^"]+)"', init, re.M)
    if not found or found.group(1) != version:
        sys.exit(f"{src} holds panel version {found.group(1) if found else '?'}, not {version}.")

    panel = ADDON / "panel"
    shutil.rmtree(panel)
    (panel / "docker").mkdir(parents=True)
    for name in FILES:
        if (src / name).exists():
            shutil.copy(src / name, panel / name)
    for name in DIRS:
        shutil.copytree(src / name, panel / name, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copy(src / "docker" / "entrypoint.sh", panel / "docker" / "entrypoint.sh")
    # Not used by the build. Kept so a change in what upstream's image installs shows up in the diff:
    # the add-on's own Dockerfile then needs the same change.
    shutil.copy(src / "Dockerfile", panel / "Dockerfile.upstream")

    cfg = ADDON / "config.yaml"
    text = cfg.read_text(encoding="utf-8")
    new, n = re.subn(r'^version: "[^"]*"', f'version: "{version}-ha1"', text, count=1, flags=re.M)
    if n != 1:
        sys.exit("Couldn't find the version line in config.yaml")
    cfg.write_text(new, encoding="utf-8")

    log = ADDON / "CHANGELOG.md"
    text = log.read_text(encoding="utf-8")
    entry = (f"## {version}-ha1\n- Tiiny Control Panel {version}. What's new in the panel: "
             f"https://github.com/0xStian/tiiny-control-panel/releases/tag/v{version}\n")
    if f"## {version}-ha1" not in text:
        log.write_text(text.replace("# Changelog\n", "# Changelog\n\n" + entry, 1), encoding="utf-8")
    print(f"Panel {version} copied; add-on version is now {version}-ha1.")


if __name__ == "__main__":
    main()
