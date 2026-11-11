"""Updating the panel itself (System → Tiiny Control Panel).

Nothing is sent anywhere unless you ask. "Check for updates" (or the daily check, if you switch it on) asks GitHub's
API for the panel's latest release, with a generic User-Agent and nothing about you. Installing an update:

  * A git checkout (you cloned the panel with git and haven't changed its files): `git pull --ff-only`, the same
    command you would run yourself.
  * Otherwise the release's ZIP from GitHub. It's checked first (only the panel's own files, nothing outside its
    folder, no links, the version it says it is), unpacked next to the panel and swapped in. The old files are kept
    in .previous/ and put back if anything goes wrong.

Your data (~/.local/share/tiiny-ui and ~/.config/tiiny-ui) is never touched. Afterwards the panel restarts itself;
tiiny_ui.py does that part, because it owns the listeners.

TIINY_UI_UPDATE_API points the check at another server, for testing. Like --tiiny, it can only be set when starting the
panel, never from the page.

In the Docker image (TIINY_UI_CONTAINER=1) the check still works, but the panel never changes its own files: a container
is updated by pulling the new image, so the page shows those commands instead (install_kind() says "container").
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

from . import REPO, VERSION

APP_DIR = Path(__file__).resolve().parent.parent      # the folder with tiiny_ui.py
API_BASE = (os.environ.get("TIINY_UI_UPDATE_API") or "https://api.github.com").rstrip("/")
USER_AGENT = f"tiiny-control-panel/{VERSION}"
CHECK_TTL = 3600             # a check is reused for an hour unless you press Check again
DAILY = 24 * 3600
MAX_ZIP = 100 * 1024 ** 2    # the release ZIP
MAX_FILE = 50 * 1024 ** 2    # any one file in it
MAX_TOTAL = 300 * 1024 ** 2  # everything it unpacks to
# What an update may replace: the panel's own files. The rest of a release ZIP is left out, and nothing else in the
# panel's folder is touched (your own notes next to it stay where they are).
MANAGED_DIRS = ("tiinyui", "static", "docs", ".github", "docker")
MANAGED_FILES = ("tiiny_ui.py", "LICENSE", ".gitignore", "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md",
                 "THIRD_PARTY_NOTICES.md", "Dockerfile", "compose.yaml", ".dockerignore")
NEEDED = ("tiiny_ui.py", "tiinyui/__init__.py", "static/index.html")
PREVIOUS = ".previous"       # the version before the last update, in the panel's folder
STAGING = ".update-"         # where an update is unpacked before it's swapped in

_lock = threading.RLock()
_state = {"checked_at": 0.0, "release": None, "error": "", "error_at": 0.0}


class UpdateError(Exception):
    """Something kept the update from going ahead; the message says what, in plain words."""


def parse_version(v):
    """'v1.2.3' or '1.2' → (1, 2, 3) / (1, 2, 0). Anything else (pre-releases too) → None."""
    m = re.fullmatch(r"v?(\d+)\.(\d+)(?:\.(\d+))?", str(v or "").strip())
    return (int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)) if m else None


def is_newer(latest, current=VERSION) -> bool:
    a, b = parse_version(latest), parse_version(current)
    return bool(a and b and a > b)


def text_version(text: str) -> str:
    m = re.search(r"""^VERSION\s*=\s*["']([^"']+)["']""", text or "", re.M)
    return m.group(1) if m else ""


def file_version(path: Path) -> str:
    try:
        return text_version(Path(path).read_text(encoding="utf-8", errors="replace"))
    except OSError:
        return ""


# -- asking GitHub -------------------------------------------------------------------------------------------------
def _request(url: str, accept: str = "application/vnd.github+json"):
    return urllib.request.Request(url, headers={"Accept": accept, "User-Agent": USER_AGENT, "X-GitHub-Api-Version": "2022-11-28"})


def _reason(e) -> str:
    r = getattr(e, "reason", None) or e
    return str(r).strip() or e.__class__.__name__


def _latest_release():
    """The newest published release, {} when there is none yet."""
    try:
        with urllib.request.urlopen(_request(f"{API_BASE}/repos/{REPO}/releases/latest"), timeout=15) as r:
            data = json.loads(r.read(2_000_000).decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {}
        if e.code in (403, 429):
            raise UpdateError("GitHub is limiting update checks from your network right now. Try again in an hour.")
        raise UpdateError(f"GitHub answered HTTP {e.code} when asked for the latest version.")
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise UpdateError(f"Couldn't reach GitHub to check for updates ({_reason(e)}). Is this computer online?")
    if not isinstance(data, dict):
        raise UpdateError("GitHub sent an answer the panel doesn't understand.")
    tag = str(data.get("tag_name") or "")
    url = str(data.get("html_url") or "")
    return {"tag": tag, "version": tag[1:] if tag[:1] in "vV" else tag, "name": str(data.get("name") or tag)[:200],
            "notes": str(data.get("body") or "")[:20000], "published": str(data.get("published_at") or ""),
            "url": url if url.startswith("https://") else f"https://github.com/{REPO}/releases"}


def check(force: bool = False) -> dict:
    """Ask GitHub for the latest release, reusing a check from the last hour unless `force`."""
    with _lock:
        if not force and _state["checked_at"] and time.time() - _state["checked_at"] < CHECK_TTL:
            return status()
    try:
        rel, err = _latest_release(), ""
    except UpdateError as e:
        rel, err = None, str(e)
    with _lock:
        if err:
            _state.update(error=err, error_at=time.time())
        else:
            _state.update(release=rel, checked_at=time.time(), error="")
    return status()


def summary() -> dict:
    """What the last check found, without asking anyone (for the page's health info)."""
    with _lock:
        rel = _state["release"] or {}
        return {"latest": rel.get("version") or None, "newer": is_newer(rel.get("version")),
                "checked_at": _state["checked_at"] or None}


def status() -> dict:
    with _lock:
        rel = _state["release"]
        out = {"current": VERSION, "repo": REPO, "checked_at": _state["checked_at"] or None, "error": _state["error"],
               "release": rel or None, "no_releases": rel == {}, "latest": (rel or {}).get("version") or None,
               "newer": is_newer((rel or {}).get("version"))}
    out["how"], out["how_note"] = install_kind()
    prev = APP_DIR / PREVIOUS
    out["previous"] = file_version(prev / "tiinyui" / "__init__.py") or None if prev.is_dir() else None
    return out


def start_daily(settings):
    """When "Check once a day" is on, check about once a day in the background."""
    def loop():
        time.sleep(90)
        while True:
            try:
                if settings.get("update_check_daily"):
                    with _lock:
                        due = time.time() - _state["checked_at"] > DAILY and time.time() - _state["error_at"] > 3600
                    if due:
                        check(force=True)
            except Exception:  # noqa: BLE001 - a missed check is retried later
                pass
            time.sleep(1800)
    threading.Thread(target=loop, daemon=True, name="update-check").start()


# -- how this copy can be updated ----------------------------------------------------------------------------------
def _git(*args, timeout=60) -> str:
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", LC_ALL="C")
    try:
        p = subprocess.run(["git", "-C", str(APP_DIR), *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        raise UpdateError("git took too long to answer.")
    except OSError as e:
        raise UpdateError(f"Couldn't run git: {e}")
    if p.returncode != 0:
        msg = (p.stderr or p.stdout or "").strip()
        raise UpdateError(msg[-600:] or f"git stopped with code {p.returncode}.")
    return p.stdout


CONTAINER_UPDATE = "docker compose pull && docker compose up -d"


def install_kind():
    """How this copy can be updated: ("git", ""), ("zip", ""), ("container", the commands that update the image),
    or ("manual", why it can't do it by itself)."""
    if os.environ.get("TIINY_UI_CONTAINER", "").strip().lower() in ("1", "true", "yes", "on"):
        return "container", CONTAINER_UPDATE
    if (APP_DIR / ".git").exists():
        if not shutil.which("git"):
            return "manual", "This copy of the panel was cloned with git, but git isn't installed. Install git, then try again."
        try:
            changed = _git("status", "--porcelain", "--untracked-files=no", timeout=20)
        except UpdateError as e:
            return "manual", f"git couldn't check this copy of the panel: {e}"
        if changed.strip():
            return "manual", ("Some of the panel's files were changed on this computer, so it won't overwrite them. "
                              "Update with git yourself, for example: git stash, then git pull.")
        try:
            _git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}", timeout=20)
        except UpdateError:
            return "manual", "This git copy doesn't follow a branch on GitHub, so update it with git yourself."
        return "git", ""
    for p in (APP_DIR, APP_DIR / "tiiny_ui.py", APP_DIR / "tiinyui", APP_DIR / "static"):
        if p.exists() and not os.access(p, os.W_OK):
            return "manual", (f"Your user account can't change the panel's files in {APP_DIR}. "
                              f"Download the new version from https://github.com/{REPO}/releases instead.")
    return "zip", ""


# -- installing ----------------------------------------------------------------------------------------------------
def install(job) -> dict:
    """Get and put in place the latest release (a background job). The panel restarts afterwards (tiiny_ui.py)."""
    job.update(message="Checking for the latest version…")
    st = check(force=True)
    if st["error"]:
        raise UpdateError(st["error"])
    if st["no_releases"]:
        raise UpdateError("No version of the panel has been published on GitHub yet.")
    if not st["newer"]:
        raise UpdateError("You already have the latest version.")
    kind, note = install_kind()
    if kind == "git":
        return _install_git(job)
    if kind == "zip":
        return _install_zip(job, st["release"])
    if kind == "container":
        raise UpdateError(f"This panel runs in a container. Update it on the server with: {note}")
    raise UpdateError(note)


def _install_git(job) -> dict:
    job.update(message="Getting the new version with git…", log="git pull --ff-only")
    out = _git("pull", "--ff-only", timeout=300)
    job.update(log=out.strip()[-2000:] or "(no output)")
    v = file_version(APP_DIR / "tiinyui" / "__init__.py")
    if v == VERSION:
        raise UpdateError("git didn't find anything new on GitHub. Try again in a few minutes.")
    return {"version": v, "how": "git", "restart": True}


def _install_zip(job, rel) -> dict:
    tag, version = rel["tag"], rel["version"]
    if not parse_version(version):
        raise UpdateError(f"The latest release has a version the panel doesn't understand ({tag}).")
    staging = APP_DIR / f"{STAGING}{version}"
    shutil.rmtree(staging, ignore_errors=True)
    try:
        staging.mkdir()
    except OSError as e:
        raise UpdateError(f"Couldn't make room for the update next to the panel: {e}")
    try:
        zpath = staging / "release.zip"
        _download(f"{API_BASE}/repos/{REPO}/zipball/{urllib.parse.quote(tag)}", zpath, job)
        job.check()
        new = staging / "new"
        _unpack(zpath, new, version, job)
        job.check()
        job.update(message="Putting the new version in place…", progress=0.95)
        _swap(new)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    job.update(log=f"Installed {version}. The old version is kept in {APP_DIR / PREVIOUS}.")
    return {"version": version, "how": "zip", "restart": True}


def _download(url: str, dest: Path, job):
    job.update(message="Downloading the new version…", progress=0.0)
    last = 0.0
    try:
        with urllib.request.urlopen(_request(url, "application/zip, application/octet-stream"), timeout=60) as r, \
                open(dest, "wb") as f:
            total = int(r.headers.get("Content-Length") or 0)
            done = 0
            while True:
                chunk = r.read(1 << 16)
                if not chunk:
                    break
                done += len(chunk)
                if done > MAX_ZIP:
                    raise UpdateError("The download is far bigger than a panel release, so it was stopped.")
                f.write(chunk)
                if time.time() - last > 0.4:
                    last = time.time()
                    job.update(message=f"Downloading the new version… {done / 1048576:.1f} MB",
                               progress=min(0.8, done / total * 0.8) if total else None)
                    job.check()
    except urllib.error.HTTPError as e:
        raise UpdateError(f"GitHub answered HTTP {e.code} for the download.")
    except (urllib.error.URLError, OSError) as e:
        raise UpdateError(f"The download stopped ({_reason(e)}).")


def _managed(parts) -> bool:
    top = parts[0]
    if len(parts) == 1:
        return top in MANAGED_FILES or top.endswith(".md")
    return top in MANAGED_DIRS and "__pycache__" not in parts


def _unpack(zpath: Path, dest: Path, version: str, job):
    """Check the release ZIP and unpack the panel's files from it into `dest`."""
    try:
        z = zipfile.ZipFile(zpath)
    except (zipfile.BadZipFile, OSError):
        raise UpdateError("The download isn't a ZIP file, so it wasn't used.")
    with z:
        infos = [i for i in z.infolist() if not i.filename.endswith("/")]
        # GitHub's ZIPs hold one folder named after the repository and the commit
        tops = {i.filename.split("/", 1)[0] for i in infos}
        prefix = next(iter(tops)) + "/" if len(tops) == 1 and all("/" in i.filename for i in infos) else ""
        plan, total = [], 0
        for i in infos:
            name = i.filename[len(prefix):]
            parts = name.split("/")
            if name.startswith("/") or "\\" in name or ":" in parts[0] or any(p in ("", ".", "..") for p in parts):
                raise UpdateError(f"The download has a file with an unsafe name ({name[:120]}), so it wasn't used.")
            if stat.S_ISLNK((i.external_attr >> 16) & 0o177777):
                raise UpdateError(f"The download has a link in it ({name[:120]}), so it wasn't used.")
            if not _managed(parts):
                continue
            total += i.file_size
            if i.file_size > MAX_FILE or total > MAX_TOTAL:
                raise UpdateError("The download unpacks to far more than a panel release, so it wasn't used.")
            plan.append((i, parts))
        by_name = {"/".join(p): i for i, p in plan}
        for need in NEEDED:
            if need not in by_name:
                raise UpdateError(f"The download doesn't look like the Tiiny Control Panel (it has no {need}), so it wasn't used.")
        said = text_version(z.read(by_name["tiinyui/__init__.py"]).decode("utf-8", "replace"))
        if said != version:
            raise UpdateError(f"The download says it's version {said or '?'}, not {version}, so it wasn't used.")
        last = 0.0
        for n, (i, parts) in enumerate(plan):
            target = dest.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(i) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out, 1 << 16)
            os.chmod(target, 0o755 if (i.external_attr >> 16) & 0o111 else 0o644)
            if time.time() - last > 0.4:
                last = time.time()
                job.update(message="Unpacking…", progress=0.8 + 0.15 * (n + 1) / len(plan))
    return sorted({p[0] for _, p in plan})


def _swap(new: Path):
    """Move the panel's current files to .previous/ and the new ones in their place. Any error puts the old ones back."""
    prev = APP_DIR / PREVIOUS
    shutil.rmtree(prev, ignore_errors=True)
    prev.mkdir()
    incoming = {p.name for p in new.iterdir()}
    names = sorted(incoming | {n for n in MANAGED_DIRS + MANAGED_FILES if (APP_DIR / n).exists()})
    moved_old, moved_new = [], []
    try:
        for name in names:
            cur = APP_DIR / name
            if cur.exists() or cur.is_symlink():
                os.replace(cur, prev / name)
                moved_old.append(name)
            if name in incoming:
                os.replace(new / name, cur)
                moved_new.append(name)
    except OSError as e:
        for name in moved_new:
            _unlink(APP_DIR / name)
        for name in moved_old:
            try:
                os.replace(prev / name, APP_DIR / name)
            except OSError:
                pass
        raise UpdateError(f"Couldn't replace the panel's files ({e}). The old version was put back.")


def _unlink(p: Path):
    try:
        if p.is_dir() and not p.is_symlink():
            shutil.rmtree(p, ignore_errors=True)
        else:
            p.unlink()
    except OSError:
        pass
