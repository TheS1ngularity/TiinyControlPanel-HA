"""Agent mode on this computer: run commands, read and write files.

Off unless the panel was started with --allow-commands, never available to phones, and the page asks you
before every command and every file change (that can't be switched off). Everything runs with your own
rights. sudo can't work: commands get no terminal and no input, so nothing can ask for a password.

Commands run as background jobs (see jobs.py), so the page follows their output and can stop them:
- in their own session and process group, so Stop or the time limit ends everything they started
  (programs started in the background with & keep running after a command that finished by itself);
- with output going to a private file rather than a pipe, so a program left running in the background
  can never block on a full pipe;
- keeping the start and the end of long output.
"""

from __future__ import annotations

import codecs
import fnmatch
import getpass
import os
import platform
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from .clitools import clean_text
from .common import BadRequest

DEFAULT_TIMEOUT = 120
MAX_TIMEOUT = 900
MAX_COMMAND = 8000
HEAD_CHARS = 12_000          # output kept from the start…
TAIL_CHARS = 48_000          # …and from the end
MAX_READ_BYTES = 20 * 1024 * 1024
MAX_READ_CHARS = 60_000
MAX_WRITE_BYTES = 2 * 1024 * 1024
FIND_SECONDS = 20
FIND_MAX_FILES = 200_000
FIND_TEXT_BYTES = 2 * 1024 * 1024
# Folders find_files never goes into: tool caches and installed packages, not the user's own files.
SKIP_DIRS = {"node_modules", "__pycache__", ".git", ".hg", ".svn", "venv", ".venv", ".tox", ".mypy_cache", ".pytest_cache",
             "site-packages", "dist-packages"}
# What open_on_computer refuses: anything that would run a program instead of showing a file.
PROGRAM_EXTS = {".desktop", ".sh", ".bash", ".zsh", ".fish", ".csh", ".run", ".bin", ".appimage", ".exe", ".msi", ".bat", ".cmd",
                ".com", ".jar", ".deb", ".rpm", ".apk", ".flatpakref", ".flatpak", ".snap", ".py", ".pl", ".rb", ".command", ".app"}


def shell() -> str:
    return shutil.which("bash") or "/bin/sh"


def os_name() -> str:
    try:
        for line in Path("/etc/os-release").read_text().splitlines():
            if line.startswith("PRETTY_NAME="):
                return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return f"{platform.system()} {platform.release()}".strip()


def environment() -> dict:
    """What the agent is told about this computer."""
    return {"shell": Path(shell()).name, "home": str(Path.home()), "os": os_name(), "user": getpass.getuser()}


def _path(raw: str) -> Path:
    p = Path(os.path.expanduser(str(raw or "").strip()))
    if not str(raw or "").strip():
        raise BadRequest("Say which file.")
    return p if p.is_absolute() else Path.home() / p


def _env() -> dict:
    env = dict(os.environ)
    home = Path.home()
    parts = env.get("PATH", "/usr/local/bin:/usr/bin:/bin").split(os.pathsep)
    extra = [str(p) for p in (home / ".local/bin", home / ".local/tiiny/bin") if p.is_dir() and str(p) not in parts]
    env["PATH"] = os.pathsep.join(extra + parts)
    # No colours, pagers or prompts: there's nobody at a terminal to answer them.
    env.update(TERM="dumb", NO_COLOR="1", PAGER="cat", GIT_PAGER="cat", SYSTEMD_PAGER="cat", GIT_TERMINAL_PROMPT="0")
    return env


def prepare(command, cwd="", timeout=None) -> dict:
    """Check a command before it runs (so mistakes show up at once, not in a failed job)."""
    command = str(command or "").strip()
    if not command:
        raise BadRequest("The command is empty.")
    if len(command) > MAX_COMMAND:
        raise BadRequest(f"That command is longer than {MAX_COMMAND} characters. Put it in a script with write_file first.")
    folder = Path(os.path.expanduser(str(cwd or "").strip() or "~"))
    if not folder.is_absolute():
        folder = Path.home() / folder
    if not folder.is_dir():
        raise BadRequest(f"There's no folder {folder}.")
    try:
        timeout = int(timeout or DEFAULT_TIMEOUT)
    except (TypeError, ValueError):
        timeout = DEFAULT_TIMEOUT
    return {"command": command, "cwd": str(folder), "timeout": max(5, min(MAX_TIMEOUT, timeout))}


class _Output:
    """The start and the end of a command's output, with what was skipped in between."""

    def __init__(self):
        self.head, self.tail, self.skipped = "", "", 0

    def add(self, text: str):
        if len(self.head) < HEAD_CHARS:
            room = HEAD_CHARS - len(self.head)
            self.head, text = self.head + text[:room], text[room:]
        if text:
            self.tail += text
            if len(self.tail) > TAIL_CHARS:
                self.skipped += len(self.tail) - TAIL_CHARS
                self.tail = self.tail[-TAIL_CHARS:]

    def text(self) -> str:
        if not self.skipped:
            return clean_text(self.head + self.tail)
        return clean_text(self.head) + f"\n… ({self.skipped:,} characters left out) …\n" + clean_text(self.tail)

    def gap(self, n: int):
        """n characters skipped unread (a flood of output): what's in the tail now is from before them."""
        self.skipped += len(self.tail) + n
        self.tail = ""

    def last_line(self) -> str:
        for line in reversed(clean_text((self.head + self.tail)[-2000:]).splitlines()):
            if line.strip():
                return line.strip()[:200]
        return ""


def _stop(proc):
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            return
        try:
            proc.wait(timeout=3)
            return
        except subprocess.TimeoutExpired:
            continue


def run(job, spec: dict) -> dict:
    """Run a prepared command inside a job. Returns {command, cwd, exit_code, output, seconds, timed_out, cancelled}."""
    tmpdir = tempfile.mkdtemp(prefix="tiiny-cmd-")
    path = os.path.join(tmpdir, "output")
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_APPEND, 0o600)  # appends never fight over the offset
    os.unlink(path)
    os.rmdir(tmpdir)
    out, offset, reason = _Output(), 0, ""
    decoder = codecs.getincrementaldecoder("utf-8")("replace")  # characters split across reads stay whole
    started = time.time()
    job.update(message="Starting…")

    def pull(final=False):
        nonlocal offset, decoder
        budget = 8_000_000  # per call, so a program flooding output can't keep this busy
        if final:
            size = os.fstat(fd).st_size
            if size - offset > budget:  # only the end is kept anyway: skip to it
                skip = size - offset - 256_000
                out.gap(skip)
                offset += skip
                decoder = codecs.getincrementaldecoder("utf-8")("replace")
        while budget > 0:
            chunk = os.pread(fd, min(65536, budget), offset)
            if not chunk:
                break
            offset += len(chunk)
            budget -= len(chunk)
            out.add(decoder.decode(chunk))
        if final:
            out.add(decoder.decode(b"", final=True))

    try:
        proc = subprocess.Popen([shell(), "-c", spec["command"]], cwd=spec["cwd"], stdin=subprocess.DEVNULL, stdout=fd,
                                stderr=fd, env=_env(), start_new_session=True, close_fds=True)
    except OSError as e:
        os.close(fd)
        raise BadRequest(f"Couldn't start the command: {e}") from None
    try:
        last = None
        while proc.poll() is None:
            if job.cancel_event.is_set():
                reason = "cancelled"
                break
            if time.time() - started > spec["timeout"]:
                reason = "timeout"
                break
            pull()
            line = out.last_line()
            if line != last:
                last = line
                job.update(message=line or "Running…")
            time.sleep(0.25)
        if reason:
            _stop(proc)
        proc.wait()
        time.sleep(0.05)
        pull(final=True)
    finally:
        os.close(fd)
    code = proc.returncode
    return {"command": spec["command"], "cwd": spec["cwd"], "exit_code": code if code is not None and code >= 0 else None,
            "signal": -code if code is not None and code < 0 else None, "output": out.text(), "truncated": bool(out.skipped),
            "seconds": round(time.time() - started, 1), "timed_out": reason == "timeout", "cancelled": reason == "cancelled",
            "timeout": spec["timeout"]}


def read_file(raw_path, start_line=1, max_lines=400) -> dict:
    p = _path(raw_path)
    if p.is_dir():
        raise BadRequest(f"{p} is a folder. List it with run_command (for example ls -la).")
    if not p.is_file():
        raise BadRequest(f"There's no file at {p}.")
    size = p.stat().st_size
    if size > MAX_READ_BYTES:
        raise BadRequest(f"{p} is {size // (1024 * 1024)} MB, too big to read whole. Look at parts of it with run_command (head, tail, grep).")
    data = p.read_bytes()
    if b"\0" in data[:8192]:
        raise BadRequest(f"{p} looks like a binary file, not text.")
    lines = data.decode("utf-8", "replace").splitlines()
    try:
        start = max(1, int(start_line or 1))
        count = max(1, min(2000, int(max_lines or 400)))
    except (TypeError, ValueError):
        start, count = 1, 400
    end = min(len(lines), start + count - 1)
    text = "\n".join(lines[start - 1:end])
    cut = len(text) > MAX_READ_CHARS
    if cut:
        text = text[:MAX_READ_CHARS]
        end = start + text.count("\n")
    return {"path": str(p), "size": size, "lines_total": len(lines), "start": start if lines else 0, "end": end,
            "text": text, "more": end < len(lines) or cut}


def write_file(raw_path, content, overwrite=False, append=False) -> dict:
    p = _path(raw_path)
    content = "" if content is None else str(content)
    data = content.encode("utf-8")
    if len(data) > MAX_WRITE_BYTES:
        raise BadRequest(f"That's more than {MAX_WRITE_BYTES // (1024 * 1024)} MB of text; write it in parts with append.")
    if p.is_dir():
        raise BadRequest(f"{p} is a folder.")
    existed = p.exists()
    if existed and not (overwrite or append):
        raise BadRequest(f"{p} already exists. Ask the user first, then call write_file again with overwrite: true (or append: true to add to the end).")
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "ab" if append else "wb") as f:
        f.write(data)
    return {"path": str(p), "bytes": len(data), "created": not existed, "appended": bool(append and existed),
            "size": p.stat().st_size}


def _grep(path: str, needle: str):
    """(line number, line) of the first line containing needle (any case), or None. Skips binary files."""
    try:
        with open(path, "rb") as f:
            data = f.read(FIND_TEXT_BYTES)
    except OSError:
        return None
    if b"\0" in data[:8192]:
        return None
    for n, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
        if needle in line.lower():
            return n, line.strip()[:200]
    return None


def find_files(folder="", name="", text="", max_results=50, include_hidden=False) -> dict:
    """Files under folder (home by default) whose name matches and/or that contain text. Newest first."""
    root = Path(os.path.expanduser(str(folder or "").strip() or "~"))
    if not root.is_absolute():
        root = Path.home() / root
    if not root.is_dir():
        raise BadRequest(f"There's no folder {root}.")
    name, text = str(name or "").strip(), str(text or "").strip()
    if not name and not text:
        raise BadRequest("Say what to look for: part of a file name (or a pattern like *.pdf), or text inside the files.")
    pattern = name.lower() if any(c in name for c in "*?[") else f"*{name.lower()}*"
    needle = text.lower()
    try:
        max_results = max(1, min(200, int(max_results or 50)))
    except (TypeError, ValueError):
        max_results = 50
    started, scanned, stopped, found = time.time(), 0, "", []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and (include_hidden or not d.startswith(".")))
        if dirpath.startswith(("/proc", "/sys", "/dev", "/run")) and str(root) not in ("/proc", "/sys", "/dev", "/run"):
            dirnames[:] = []
            continue
        for fn in filenames:
            scanned += 1
            if scanned > FIND_MAX_FILES:
                stopped = "files"
                break
            if scanned % 200 == 0 and time.time() - started > FIND_SECONDS:
                stopped = "time"
                break
            if (not include_hidden and fn.startswith(".")) or (name and not fnmatch.fnmatch(fn.lower(), pattern)):
                continue
            path = os.path.join(dirpath, fn)
            try:
                st = os.lstat(path)
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode):
                continue
            hit = None
            if needle:
                if st.st_size > FIND_TEXT_BYTES:
                    continue
                hit = _grep(path, needle)
                if not hit:
                    continue
            item = {"path": path, "size": st.st_size, "modified": st.st_mtime}
            if hit:
                item["line"], item["match"] = hit
            found.append(item)
            if len(found) >= 5000:
                stopped = "results"
                break
        if stopped:
            break
    found.sort(key=lambda r: r["modified"], reverse=True)
    return {"folder": str(root), "results": found[:max_results], "matched": len(found), "more": len(found) > max_results or bool(stopped),
            "stopped": stopped, "scanned": scanned, "seconds": round(time.time() - started, 1)}


def _opener(arg: str):
    if shutil.which("xdg-open"):
        return ["xdg-open", arg]
    if shutil.which("gio"):
        return ["gio", "open", arg]
    if sys.platform == "darwin" and shutil.which("open"):
        return ["open", arg]
    return None


def open_target(target) -> dict:
    """Open a file or folder in its usual app, or a web link in the browser. Never runs programs."""
    target = str(target or "").strip()
    if not target:
        raise BadRequest("Say what to open: a file, a folder or a web link.")
    if re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I) and not re.match(r"^[a-z]:[\\/]", target, re.I):
        if not re.match(r"^https?://\S+$", target, re.I):
            raise BadRequest("Only web links (http or https), files and folders can be opened.")
        what, arg = "link", target
    else:
        p = _path(target)
        if not p.exists():
            raise BadRequest(f"There's nothing at {p}.")
        if not p.is_dir():
            if p.suffix.lower() in PROGRAM_EXTS or os.access(p, os.X_OK):
                raise BadRequest(f"{p} is a program or a script. For safety, open_on_computer never runs programs; "
                                 "use run_command if the user wants to run it.")
        what, arg = ("folder" if p.is_dir() else "file"), str(p)
    if sys.platform.startswith("linux") and not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        raise BadRequest("There's no desktop to open it on: the panel was started outside your desktop session (for example as a service).")
    cmd = _opener(arg)
    if not cmd:
        raise BadRequest("No program for opening files was found. Install xdg-utils (it provides xdg-open).")
    with tempfile.TemporaryFile() as err:
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=err, env=_env(),
                                    start_new_session=True, close_fds=True)
        except OSError as e:
            raise BadRequest(f"Couldn't start {cmd[0]}: {e}") from None
        try:
            code = proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            code = 0  # still busy handing it to the app: that's fine
        if code:
            err.seek(0)
            detail = clean_text(err.read(2000).decode("utf-8", "replace")).strip()
            raise BadRequest(f"Couldn't open it ({cmd[0]} said: {detail or f'exit code {code}'}).")
    return {"opened": arg, "what": what, "with": cmd[0]}

