"""An entry in the desktop's app menu (freedesktop .desktop file) that starts the panel."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

APP_ID = "tiiny-control-panel"


def _data_home() -> Path:
    return Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share"))


def _paths():
    base = _data_home()
    return (base / "applications" / f"{APP_ID}.desktop",
            {size: base / "icons" / "hicolor" / f"{size}x{size}" / "apps" / f"{APP_ID}.png" for size in (192, 512)})


def _quote(arg: str) -> str:
    """Quote one Exec argument as the Desktop Entry spec asks."""
    if not any(c in arg for c in ' \t\n"\'\\><~|&;$*?#()`'):
        return arg.replace("%", "%%")
    return '"' + arg.replace("\\", "\\\\").replace('"', '\\"').replace("`", "\\`").replace("$", "\\$").replace("%", "%%") + '"'


def status() -> dict:
    desktop, icons = _paths()
    return {"installed": desktop.is_file(), "path": str(desktop), "supported": sys.platform.startswith("linux")}


def install(script: Path, static_dir: Path, args=()) -> dict:
    if not sys.platform.startswith("linux"):
        raise OSError("App menu entries are only supported on Linux.")
    desktop, icons = _paths()
    for size, dest in icons.items():
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(static_dir / "icons" / f"icon-{size}.png", dest)
    desktop.parent.mkdir(parents=True, exist_ok=True)
    exec_line = " ".join(_quote(a) for a in (sys.executable, str(Path(script).resolve()), *args))
    desktop.write_text("\n".join([
        "[Desktop Entry]", "Type=Application", "Version=1.0", "Name=Tiiny Control Panel",
        "Comment=Chat, projects, models and more on your Tiiny AI device", f"Exec={exec_line}", f"Icon={icons[512]}",
        "Terminal=false", "Categories=Utility;Development;", "StartupNotify=true", f"StartupWMClass={APP_ID}", ""]), encoding="utf-8")
    desktop.chmod(0o755)
    for tool in (["update-desktop-database", str(desktop.parent)],):
        if shutil.which(tool[0]):
            subprocess.run(tool, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20, check=False)
    return status()


def remove() -> dict:
    desktop, icons = _paths()
    for p in [desktop, *icons.values()]:
        try:
            p.unlink()
        except FileNotFoundError:
            pass
    return status()
