"""Running the tiiny CLI, parsing its text output, and tracking files exchanged with the page."""

from __future__ import annotations

import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING

from .common import BadRequest, first_line, guess_mime, safe_name

if TYPE_CHECKING:
    from .settings import Settings

FILE_TTL = 6 * 3600


ANSI_RE = re.compile(
    r"\x1b\[[0-?]*[ -/]*[@-~]"              # CSI: colours, cursor movement
    r"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"   # OSC: titles, hyperlinks
    r"|\x1b[PX^_][^\x1b]*\x1b\\"            # DCS / SOS / PM / APC
    r"|\x1b[()*+][0-9A-Za-z]"               # character set selection
    r"|\x1b[@-_0-?]"                        # remaining two-byte escapes
)


CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


JSON_START_RE = re.compile(r"(?m)^[ \t]*[\[{]")


KV_RE = re.compile(r"^\s*([A-Za-z][\w ()/.\-]{0,48}?)\s*[:：]\s+(\S.*?)\s*$")


TABLE_SEP_RE = re.compile(r"^[\s\-─━═=+:|│┃║┼┬┴├┤┌┐└┘╭╮╯╰╞╡╪╋┏┓┗┛┣┫┳┻]*$")


SPAN_RE = re.compile(r"\S+(?: \S+)*")


BOX_EDGES = "│┃║|"


def clean_text(text: str) -> str:
    """Strip terminal escapes and keep only the final state of `\\r` progress redraws."""
    text = ANSI_RE.sub("", text)
    lines = []
    for line in text.split("\n"):
        if "\r" in line:
            parts = [p for p in line.split("\r") if p.strip()]
            line = parts[-1] if parts else ""
        lines.append(CTRL_RE.sub("", line))
    return "\n".join(lines)


def parse_json_loose(text: str):
    """Return the JSON value in `text`, tolerating log lines around it."""
    t = text.strip()
    if not t:
        return None
    if t[0] in "[{":
        try:
            return json.loads(t)
        except ValueError:
            pass
    dec = json.JSONDecoder()
    values, last_end = [], -1
    for m in JSON_START_RE.finditer(t):
        start = m.end() - 1
        if start < last_end:
            continue
        try:
            obj, end = dec.raw_decode(t, start)
        except ValueError:
            continue
        if isinstance(obj, (dict, list)):
            values.append(obj)
            last_end = end
    if not values:
        return None
    return values[0] if len(values) == 1 else values


def parse_kv(text: str):
    out = {}
    for line in text.splitlines():
        m = KV_RE.match(line)
        if m:
            out.setdefault(m.group(1).strip(), m.group(2))
    return out or None


def _spans(line: str):
    return [(m.start(), m.group()) for m in SPAN_RE.finditer(line.expandtabs(8))]


def parse_table(text: str):
    """Parse an ASCII table (`+---+` / `|` style, or column-aligned) into dicts."""
    lines = [l.rstrip() for l in text.splitlines()]
    rows = []
    for line in lines:
        s = line.strip()
        if not s or TABLE_SEP_RE.match(s):
            continue
        if len(s) > 1 and s[0] in BOX_EDGES and s[-1] in BOX_EDGES:
            rows.append([c.strip() for c in re.split(r"[│┃║|]", s[1:-1])])
    if rows and len(rows[0]) >= 2:
        header = rows[0]
        return [dict(zip(header, r)) for r in rows[1:] if len(r) == len(header)]
    for i, line in enumerate(lines):
        header = _spans(line)
        tokens = [t for _, t in header]
        if len(header) < 2 or any(t.endswith(":") for t in tokens) or not all(re.search(r"[A-Za-z]", t) for t in tokens):
            continue
        starts = [p for p, _ in header]
        data = []
        for row in lines[i + 1:]:
            if not row.strip():
                break
            if TABLE_SEP_RE.match(row.strip()):
                continue
            spans = _spans(row)
            if len(spans) == len(tokens):
                cells = [t for _, t in spans]
            else:
                expanded = row.expandtabs(8)
                cells = [expanded[a:b].strip() for a, b in zip(starts, starts[1:] + [None])]
            data.append(dict(zip(tokens, cells)))
        if data:
            return data
    return None


def display_cmd(argv) -> str:
    return shlex.join(["tiiny"] + [str(a) for a in argv[1:]])


def _executable(path: str):
    if not path:
        return None
    path = os.path.expanduser(path)
    if os.sep not in path:
        path = shutil.which(path) or ""
    if path and os.path.isfile(path) and os.access(path, os.X_OK):
        return os.path.abspath(path)
    return None


def find_tiiny(preferred: str = ""):
    """Locate the tiiny binary. Returns (path, note)."""
    note = ""
    if preferred:
        found = _executable(preferred)
        if found:
            return found, ""
        note = f"The configured path {preferred!r} is not an executable file."
    home = Path.home()
    for cand in (os.environ.get("TIINY_BIN", ""), str(home / ".local/tiiny/bin/tiiny"), "tiiny",
                 str(home / ".local/bin/tiiny"), "/usr/local/bin/tiiny"):
        found = _executable(cand)
        if found:
            return found, note
    try:  # the installer adds tiiny to PATH through ~/.profile, which a desktop launcher may skip
        out = subprocess.run(["bash", "-lc", "command -v tiiny"], capture_output=True, text=True,
                             timeout=8, stdin=subprocess.DEVNULL).stdout.strip().splitlines()
        found = _executable(out[-1]) if out else None
        if found:
            return found, note
    except (OSError, subprocess.SubprocessError):
        pass
    return "", note or "The tiiny CLI was not found on this computer."


class Runtime:
    def __init__(self, settings: Settings, explicit_bin: str = ""):
        self.settings = settings
        self.explicit_bin = explicit_bin
        self.bin = ""
        self.bin_note = ""
        self.cli_version = ""
        self.work = Path(tempfile.mkdtemp(prefix="tiiny-ui-"))
        for sub in ("uploads", "outputs", "cwd"):
            (self.work / sub).mkdir()
        self.cwd = str(self.work / "cwd")
        self.files = {}
        self.files_lock = threading.Lock()
        self.resolve_bin()

    def resolve_bin(self) -> str:
        self.bin, self.bin_note = find_tiiny(self.explicit_bin or self.settings.get("tiiny_bin"))
        self.cli_version = ""
        if self.bin:
            try:
                out = subprocess.run([self.bin, "cli", "version"], capture_output=True, text=True, timeout=15,
                                     stdin=subprocess.DEVNULL, env=self.env(), cwd=self.cwd)
                self.cli_version = first_line(clean_text(out.stdout))
            except (OSError, subprocess.SubprocessError):
                pass
        return self.bin

    def argv(self, args, json_out=False, yes=False):
        if not self.bin:
            raise BadRequest("The tiiny CLI was not found. Install it, or start the panel with --tiiny PATH if it's somewhere unusual.")
        args = list(args)
        extra = []
        if json_out:
            extra.append("--json")
        cfg = self.settings.get("cli_config")
        if cfg:
            extra.append("--config=" + os.path.expanduser(cfg))
        if yes:
            extra.append("-y")
        if "--" in args:  # global flags must stay in front of a `--` separator
            i = args.index("--")
            args[i:i] = extra
        else:
            args += extra
        return [self.bin] + args

    def env(self, tty=False):
        env = dict(os.environ)
        if self.bin:
            env["PATH"] = os.path.dirname(self.bin) + os.pathsep + env.get("PATH", "")
        if tty:
            env["TERM"] = "xterm-256color"
            env["COLORTERM"] = "truecolor"
            env.pop("NO_COLOR", None)
        else:
            env["NO_COLOR"] = "1"
            env["TERM"] = "dumb"
            env["CLICOLOR"] = "0"
        return env

    # -- files --------------------------------------------------------------------
    def register(self, path: str, name: str, kind: str) -> dict:
        fid = secrets.token_urlsafe(12)
        size = os.path.getsize(path)
        rec = {"id": fid, "path": path, "name": name, "size": size, "ts": time.time(), "kind": kind}
        with self.files_lock:
            self._gc_files()
            self.files[fid] = rec
        return {"id": fid, "name": name, "size": size, "mime": guess_mime(name), "url": f"/api/file/{fid}"}

    def get_file(self, fid: str):
        with self.files_lock:
            return self.files.get(fid)

    def _gc_files(self):
        now = time.time()
        for fid, rec in list(self.files.items()):
            if now - rec["ts"] > FILE_TTL:
                del self.files[fid]
                parent = os.path.dirname(rec["path"])
                if os.path.commonpath([os.path.abspath(parent), str(self.work)]) == str(self.work):
                    shutil.rmtree(parent, ignore_errors=True)

    def new_output_path(self, name: str) -> str:
        d = tempfile.mkdtemp(dir=self.work / "outputs")
        return os.path.join(d, safe_name(name) or "download")

    def expand(self, items):
        """Turn the page's argument list into strings.

        Plain strings pass through. Objects stand for files on this computer:
          {"file": "<upload id>", "prefix": "--file="}   a file the page uploaded
          {"out": "backup.zip", "prefix": "--output="}   a fresh output path
          {"outdir": true, "prefix": "--output="}        a fresh output directory
        Returns (args, output_dirs).
        """
        if not isinstance(items, list) or len(items) > 400:
            raise BadRequest("args must be a list")
        args, outdirs = [], []
        for it in items:
            if isinstance(it, str):
                if "\x00" in it:
                    raise BadRequest("Arguments can't contain NUL bytes")
                args.append(it)
            elif isinstance(it, (int, float)) and not isinstance(it, bool):
                args.append(str(it))
            elif isinstance(it, dict):
                prefix = it.get("prefix", "")
                if not isinstance(prefix, str):
                    raise BadRequest("prefix must be a string")
                if "file" in it:
                    rec = self.get_file(str(it["file"]))
                    if not rec or not os.path.exists(rec["path"]):
                        raise BadRequest("That uploaded file has expired. Please add it again.")
                    args.append(prefix + rec["path"])
                elif "out" in it:
                    path = self.new_output_path(str(it["out"]))
                    outdirs.append(os.path.dirname(path))
                    args.append(prefix + path)
                elif it.get("outdir"):
                    d = tempfile.mkdtemp(dir=self.work / "outputs")
                    outdirs.append(d)
                    args.append(prefix + d + os.sep)
                else:
                    raise BadRequest("Unknown argument object")
            else:
                raise BadRequest("Arguments must be strings")
        return args, outdirs

    def collect_outputs(self, outdirs):
        found = []
        for d in outdirs:
            for root, _dirs, names in os.walk(d):
                for n in sorted(names):
                    found.append(self.register(os.path.join(root, n), n, "output"))
        return found

    # -- running ------------------------------------------------------------------
    def result(self, argv, code, out_b, err_b, started, timed_out, outdirs):
        out = clean_text(out_b.decode("utf-8", "replace"))
        err = clean_text(err_b.decode("utf-8", "replace"))
        parsed = parse_json_loose(out)
        return {
            "ok": code == 0 and not timed_out,
            "code": code,
            "timed_out": timed_out,
            "cmd": display_cmd(argv),
            "stdout": out[-200_000:],
            "stderr": err[-50_000:],
            "json": parsed,
            "table": parse_table(out) if parsed is None else None,
            "kv": parse_kv(out) if parsed is None else None,
            "duration": round(time.time() - started, 3),
            "outputs": self.collect_outputs(outdirs) if outdirs else [],
        }

    def run(self, args, json_out=False, yes=False, timeout=120):
        expanded, outdirs = self.expand(args)
        argv = self.argv(expanded, json_out=json_out, yes=yes)
        started = time.time()
        timed_out = False
        try:
            p = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout,
                               env=self.env(), cwd=self.cwd, start_new_session=True)
            code, out, err = p.returncode, p.stdout, p.stderr
        except subprocess.TimeoutExpired as e:
            timed_out, code = True, None
            out, err = e.stdout or b"", e.stderr or b""
        except OSError as e:
            code, out, err = None, b"", str(e).encode()
        return self.result(argv, code, out, err, started, timed_out, outdirs)
