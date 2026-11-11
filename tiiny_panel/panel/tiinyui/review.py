"""Private code review: a local model reviews a folder (or ZIP, or a project's folder) file by file.

A fast regex pass flags hard-coded secrets first. Then each file (or ~300-line window of a big
file) goes to the chat model with line numbers and a short project overview, and must come back
as strict JSON findings. A final pass writes a short summary. Everything stays on this computer
and the Tiiny; the review is saved after every file, so an interrupted run can resume.
"""

from __future__ import annotations

import json
import re
import shutil
import threading
import time
import zipfile
from pathlib import Path

from . import activity, decide, device, jobs, npu
from .common import USAGE, BadRequest, DeviceError, estimate_tokens, new_id, now
from .files import CODE_EXTS, read_text, scan_folder

SEVERITIES = ["critical", "high", "medium", "low", "info"]
WINDOW_LINES = 300
WINDOW_OVERLAP = 20
OUTAGE_WAIT = 60  # seconds to wait for the device to come back before pausing the review


class DeviceGone(Exception):
    """The device stopped answering (off, unreachable, restarting or locked): pause the review so it can resume."""


def device_up(info) -> bool:
    """Is the device's core service answering? False when it's off, unreachable, restarting or locked."""
    try:
        status, _, _ = device.call(info, "core", "GET", "/api/v1/sys/status", timeout=8)
    except DeviceError:
        return False
    return 200 <= status < 300


WATCH_EVERY = 30  # seconds between "is the device still there?" checks while a request runs


LIVE_EVERY = 0.5   # seconds between updates of what the page shows the model writing
LIVE_TEXT = 3000   # characters of it


def _stream_chat(job, info, model, msgs, live=None, *, thinking=None, max_tokens=None, temperature=None, timeout=900):
    """device.chat, streamed: the same result, while the review's page shows what the model is writing (job.live)."""
    payload = {"model": model or "default", "messages": msgs, "stream": True}
    if max_tokens:
        payload["max_tokens"] = int(max_tokens)
    if temperature is not None:
        payload["temperature"] = float(temperature)
    extras = {"chat_template_kwargs": {"enable_thinking": bool(thinking)}} if thinking is not None else None
    content, reasoning, usage, finish, last = [], [], {}, None, 0.0
    base = dict(live or {})

    def show(final=False):
        text = "".join(content)
        if not text.strip() and reasoning:
            text = "Thinking… " + "".join(reasoning)
        job.set_live(dict(base, text=text[-LIVE_TEXT:], log=list(job.log[-6:]), done=final))

    USAGE.touch(model)
    with activity.track("/v1/chat/completions", model):   # the dashboard names it after the review
        for ev in device.stream_chat(info, payload, extras, timeout=timeout):
            if ev[0] == "delta":
                content.append(ev[1] or "")
                reasoning.append(ev[2] or "")
                if live is not None and time.time() - last >= LIVE_EVERY:
                    last = time.time()
                    show()
            elif ev[0] == "done":
                usage, finish = ev[1].get("usage") or {}, ev[1].get("finish_reason")
    if live is not None:
        show(final=True)
    c, r = "".join(content), "".join(reasoning)
    if "</think>" in c:   # some templates put the reasoning inline
        head, _, tail = c.partition("</think>")
        r = r or head.replace("<think>", "").strip()
        c = tail
    return {"content": c.strip(), "reasoning": r, "tool_calls": [], "usage": usage, "finish_reason": finish}


def _watched(job, info, fn, *args, **kwargs):
    """Run a long device request in a helper thread, so Cancel works at once and a device that
    disappears mid-request (powered off: no answer ever comes) is noticed within about a minute,
    not when the request times out."""
    box = {}

    def target():
        jobs.working_for(job)  # the device's work shows under this job on the dashboard
        try:
            box["result"] = fn(*args, **kwargs)
        except BaseException as e:  # noqa: BLE001 - handed to the job thread
            box["error"] = e

    t = threading.Thread(target=target, daemon=True)
    t.start()
    next_check, misses = time.time() + WATCH_EVERY, 0
    while t.is_alive():
        t.join(0.5)
        job.check()
        if t.is_alive() and time.time() >= next_check:
            misses = 0 if device_up(info) else misses + 1
            if misses >= 2:
                raise DeviceError("No answer from the device for over a minute")
            next_check = time.time() + WATCH_EVERY
    if "error" in box:
        raise box["error"]
    return box["result"]
LANGS = {".py": "Python", ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "JavaScript (React)",
         ".ts": "TypeScript", ".tsx": "TypeScript (React)", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin",
         ".rb": "Ruby", ".php": "PHP", ".cs": "C#", ".c": "C", ".h": "C header", ".cpp": "C++", ".cc": "C++", ".hpp": "C++ header",
         ".swift": "Swift", ".sh": "Shell", ".bash": "Shell", ".sql": "SQL", ".html": "HTML", ".vue": "Vue", ".svelte": "Svelte",
         ".yaml": "YAML", ".yml": "YAML", ".tf": "Terraform", ".dockerfile": "Dockerfile", ".scala": "Scala", ".lua": "Lua",
         ".pl": "Perl", ".ex": "Elixir", ".dart": "Dart", ".sol": "Solidity", ".json": "JSON", ".toml": "TOML", ".xml": "XML"}

FOCUS = {
    "security": ("Find security vulnerabilities: injection (SQL, command, template, LDAP, XPath), XSS, SSRF, path traversal, "
                 "unsafe deserialization, authentication and authorization flaws, missing access checks, hard-coded secrets, "
                 "weak or misused cryptography, insecure randomness, insecure defaults and configuration, CSRF, open redirects, "
                 "race conditions (TOCTOU), unvalidated input, sensitive data in logs, and dangerous use of eval/exec/shell."),
    "bugs": ("Find real bugs: logic errors, wrong conditions, off-by-one errors, unhandled None/null/undefined, unhandled "
             "errors and exceptions, resource leaks, concurrency problems, incorrect API use, broken edge cases, and code that "
             "cannot work as intended."),
    "all": ("Find security vulnerabilities (injection, XSS, SSRF, path traversal, unsafe deserialization, auth flaws, secrets, "
            "weak crypto, insecure defaults) and real bugs (logic errors, unhandled errors, null handling, leaks, concurrency, "
            "edge cases). Mention maintainability only when it is likely to cause a bug."),
}

SYSTEM = """You are a meticulous senior application-security engineer doing a code review.
{focus}

Rules:
- Report only real, specific problems that you can point to in the code shown. Don't report style, naming, or missing comments.
- Each finding must reference line numbers from the numbered code.
- Be concrete: say what an attacker or a user could do, and how to fix it.
- If there is nothing worth reporting, return an empty list. Never invent problems.

Reply with JSON only, no prose, in exactly this shape:
{{"findings": [{{"line_start": 12, "line_end": 14, "severity": "critical|high|medium|low|info", "category": "short category, e.g. SQL injection",
"title": "one-line summary", "code": "the exact line of code where the problem is, copied from the file",
"explanation": "what is wrong and why it matters", "suggestion": "how to fix it, with a short code example if useful",
"confidence": "high|medium|low"}}]}}"""

SECRET_PATTERNS = [
    ("Private key", "critical", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----")),
    ("AWS access key", "high", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("AWS secret key", "high", re.compile(r"(?i)aws.{0,24}(?:secret|private).{0,8}['\"][0-9a-zA-Z/+]{40}['\"]")),
    ("GitHub token", "high", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b")),
    ("GitLab token", "high", re.compile(r"\bglpat-[A-Za-z0-9\-_]{20,}\b")),
    ("Slack token", "high", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("Google API key", "high", re.compile(r"\bAIza[0-9A-Za-z\-_]{35}\b")),
    ("Stripe live key", "high", re.compile(r"\b(?:sk|rk)_live_[0-9a-zA-Z]{24,}\b")),
    ("AI provider API key", "high", re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b")),
    ("JSON Web Token", "medium", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
    ("Credentials in a URL", "high", re.compile(r"\b[a-z][a-z0-9+.-]{1,15}://[^/\s:@'\"]{1,64}:[^/\s:@'\"]{3,64}@[\w.-]+")),
    ("Hard-coded password or key", "medium", re.compile(
        r"(?i)\b\w*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|token|private[_-]?key)\w*\b['\"]?\s*[:=]\s*['\"]([^'\"\s]{6,})['\"]")),
]
PLACEHOLDER = re.compile(r"(?i)^(?:x+|\*+|changeme|change_me|password|secret|example|sample|dummy|test|todo|your[_-].*|<.*>|\$\{.*\}|%\(.*\)s|\{\{.*\}\}|\.\.\.)$")


def _inside(path: Path, root: Path) -> bool:
    """Is path root itself or inside it? (A text prefix test would also accept /root-other/…)"""
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _mask(s: str) -> str:
    s = s.strip()
    return s[:4] + "…" + "•" * 6 if len(s) > 8 else "•" * len(s)


def secrets_scan(path: str, text: str) -> list:
    out = []
    for lineno, line in enumerate(text.split("\n"), 1):
        if len(line) > 2000:
            continue
        for title, sev, rx in SECRET_PATTERNS:
            m = rx.search(line)
            if not m:
                continue
            value = m.group(1) if m.groups() else m.group(0)
            if title == "Hard-coded password or key" and (PLACEHOLDER.match(value) or re.match(r"(?i)^(os\.|env|process\.env|getenv)", value)):
                continue
            if title == "Credentials in a URL" and re.search(r"(?i)user(name)?:pass(word)?@|example\.(com|org)", m.group(0)):
                continue
            out.append({"line_start": lineno, "line_end": lineno, "severity": sev, "category": "Hard-coded secret",
                        "title": f"{title} in source code",
                        "explanation": f"`{_mask(value)}` looks like a real credential committed to the code. Anyone with access to the repository (or its history) can use it.",
                        "suggestion": "Remove it from the code, rotate it (assume it is compromised), and load it from an environment variable or a secrets manager.",
                        "confidence": "high" if sev in ("critical", "high") else "medium", "source": "pattern", "path": path})
            break
    return out


RISKY_CALLS = [
    ("Use of eval()", "medium", "Code execution", re.compile(r"(?<![\w.])eval\s*\("), (".py", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".php", ".rb"),
     "eval() runs whatever string it is given as code. If any part of that string can come from a user, they can run their own code.",
     "Avoid eval(); parse the input explicitly (e.g. JSON.parse, ast.literal_eval, or a small expression parser)."),
    ("Use of exec()", "medium", "Code execution", re.compile(r"(?<![\w.])exec\s*\("), (".py",),
     "exec() runs a string as Python code; user-controlled input there means remote code execution.", "Remove exec() or strictly limit what it can run."),
    ("Shell command built from a string", "medium", "Command injection",
     re.compile(r"os\.(system|popen)\s*\(|subprocess\.\w+\([^)]*shell\s*=\s*True|child_process\.exec(Sync)?\s*\(|\bshell_exec\s*\(|`\$\{"), (".py", ".js", ".mjs", ".cjs", ".ts", ".php"),
     "Running a command through the shell with string input lets an attacker add their own commands with ; | && or $(...).",
     "Pass arguments as a list without a shell (subprocess.run([...]) / execFile), and validate the input."),
    ("Unsafe deserialization", "high", "Unsafe deserialization",
     re.compile(r"pickle\.loads?\s*\(|cPickle\.loads?\s*\(|yaml\.load\s*\((?![^)]*SafeLoader)|marshal\.loads\s*\(|\bunserialize\s*\("), (".py", ".php"),
     "Deserializing untrusted data with pickle/yaml.load/unserialize can execute code chosen by an attacker.",
     "Use a data-only format (JSON) or yaml.safe_load, and never deserialize data you didn't create."),
    ("Weak hash function", "low", "Weak cryptography", re.compile(r"hashlib\.(md5|sha1)\s*\(|\bmd5\s*\(|createHash\(\s*['\"](md5|sha1)['\"]"),
     (".py", ".js", ".ts", ".php", ".rb", ".go", ".java"),
     "MD5 and SHA-1 are broken for security purposes. For passwords they are far too fast to resist cracking.",
     "Use bcrypt, scrypt or Argon2 for passwords, and SHA-256 or better for integrity checks."),
    ("Unescaped HTML sink", "medium", "XSS", re.compile(r"\.(innerHTML|outerHTML)\s*\+?=(?!=)|document\.write\s*\(|dangerouslySetInnerHTML"),
     (".js", ".mjs", ".jsx", ".ts", ".tsx", ".html", ".vue", ".svelte"),
     "Writing strings into innerHTML/document.write renders them as HTML, so user input there allows cross-site scripting.",
     "Use textContent, or sanitize with a vetted library before inserting HTML."),
    ("TLS certificate checks disabled", "medium", "Insecure transport",
     re.compile(r"verify\s*=\s*False|rejectUnauthorized\s*:\s*false|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFYPEER\s*,\s*(0|false)"),
     (".py", ".js", ".ts", ".go", ".php"),
     "Turning off certificate verification lets anyone on the network intercept and change the traffic.", "Keep verification on; add the right CA certificate instead."),
]


def risky_calls_scan(path: str, text: str) -> list:
    ext = Path(path).suffix.lower()
    out = []
    for lineno, line in enumerate(text.split("\n"), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith(("#", "//", "*", "/*")) or len(line) > 1500:
            continue
        for title, sev, cat, rx, exts, why, fix in RISKY_CALLS:
            if ext in exts and rx.search(line):
                out.append({"line_start": lineno, "line_end": lineno, "severity": sev, "category": cat, "title": title,
                            "explanation": why, "suggestion": fix, "confidence": "medium", "source": "pattern", "path": path})
                break
    return out


def _extract_json(text: str):
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.M)
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except ValueError:
        return None


def _windows(lines: list):
    if len(lines) <= WINDOW_LINES + 40:
        return [(1, len(lines))]
    out, start = [], 1
    while start <= len(lines):
        end = min(len(lines), start + WINDOW_LINES - 1)
        out.append((start, end))
        if end == len(lines):
            break
        start = end - WINDOW_OVERLAP + 1
    return out


def _numbered(lines: list, start: int, end: int) -> str:
    width = len(str(end))
    return "\n".join(f"{str(i).rjust(width)} | {lines[i - 1]}" for i in range(start, end + 1))


def _locate(code: str, lines: list, lo: int, hi: int, near: int):
    """Line number of the quoted code inside the window, closest to where the model pointed."""
    needle = re.sub(r"\s+", " ", (code or "").strip())
    if len(needle) < 6:
        return None
    hits = [i for i in range(lo, hi + 1) if needle in re.sub(r"\s+", " ", lines[i - 1])]
    if not hits and len(needle) > 40:
        needle = needle[:40]
        hits = [i for i in range(lo, hi + 1) if needle in re.sub(r"\s+", " ", lines[i - 1])]
    return min(hits, key=lambda i: abs(i - near)) if hits else None


def _norm_finding(f: dict, path: str, lo: int, hi: int, lines: list = None):
    if not isinstance(f, dict) or not str(f.get("title", "")).strip():
        return None
    try:
        ls = int(f.get("line_start") or f.get("line") or lo)
        le = int(f.get("line_end") or ls)
    except (TypeError, ValueError):
        ls, le = lo, lo
    ls = max(lo, min(hi, ls))
    le = max(ls, min(hi, le))
    if lines is not None:
        found = _locate(str(f.get("code") or ""), lines, lo, hi, ls)
        if found:
            span = max(0, le - ls)
            ls, le = found, min(hi, found + min(span, 3))
    sev = str(f.get("severity", "medium")).lower().strip()
    sev = sev if sev in SEVERITIES else {"moderate": "medium", "minor": "low", "major": "high", "severe": "critical"}.get(sev, "medium")
    conf = str(f.get("confidence", "medium")).lower()
    return {"line_start": ls, "line_end": le, "severity": sev, "category": str(f.get("category") or "Issue")[:80],
            "title": str(f["title"]).strip()[:200], "explanation": str(f.get("explanation") or "")[:3000],
            "suggestion": str(f.get("suggestion") or "")[:3000], "confidence": conf if conf in ("high", "medium", "low") else "medium",
            "source": "ai", "path": path}


def _dupe(a: dict, b: dict) -> bool:
    if a["path"] != b["path"] or a["line_start"] > b["line_end"] + 2 or b["line_start"] > a["line_end"] + 2:
        return False
    wa, wb = set(re.findall(r"\w+", a["title"].lower())), set(re.findall(r"\w+", b["title"].lower()))
    return a["category"].lower() == b["category"].lower() or len(wa & wb) >= max(2, min(len(wa), len(wb)) // 2)


class Reviews:
    def __init__(self, store, devconn, jobs, runtime, projects):
        self.store, self.devconn, self.jobs, self.rt, self.projects = store, devconn, jobs, runtime, projects

    def _get(self, rid: str) -> dict:
        rec = self.store.get("reviews", rid)
        if not rec:
            raise BadRequest("That review no longer exists.")
        return rec

    def summary(self, r: dict) -> dict:
        counts = {s: 0 for s in SEVERITIES}
        for f in r.get("findings", []):
            if f.get("state", "open") not in ("false_positive",):
                counts[f["severity"]] = counts.get(f["severity"], 0) + 1
        files = r.get("files", [])
        return {"id": r["id"], "name": r.get("name"), "root": r.get("root"), "status": r.get("status"), "created": r.get("created"),
                "updated": r.get("updated"), "counts": counts, "model": r.get("options", {}).get("model"),
                "files": len([f for f in files if f.get("selected")]), "done": len([f for f in files if f.get("status") == "done"])}

    def list(self) -> list:
        return [self.summary(r) for r in self.store.list("reviews")]

    def get(self, rid: str) -> dict:
        rec = self._get(rid)
        job = self.jobs.running("review", review=rid)
        rec["job"] = job.info(with_live=True) if job else None   # with what it's doing now, for the progress card
        if rec.get("status") == "running" and not job:
            rec["status"] = "interrupted"
        return rec

    # -- creating a review from a source -------------------------------------------------
    def create(self, spec: dict) -> dict:
        kind = spec.get("kind")
        rid = new_id("r")
        if kind == "folder":
            root = Path(str(spec.get("path", ""))).expanduser().resolve()
            name = root.name
        elif kind == "project":
            p = self.projects._get(str(spec.get("project_id", "")))
            folders = [d for d in p.get("docs", []) if d["kind"] == "folder"]
            if not folders:
                raise BadRequest("That project has no linked folder. Link one under Knowledge first.")
            root = Path(folders[0]["path"]).resolve()
            name = f"{p.get('name')} ({root.name})"
        elif kind == "zip":
            up = self.rt.get_file(str(spec.get("file_id", "")))
            if not up:
                raise BadRequest("The ZIP upload has expired. Please choose it again.")
            root = self.store.blob_dir("reviews", rid) / "src"
            self._unzip(Path(up["path"]), root)
            name = Path(up["name"]).stem
        else:
            raise BadRequest("Choose a folder, a ZIP file or a project.")
        try:
            scan = scan_folder(root, spec.get("include") or [], spec.get("exclude") or [], max_files=3000, max_bytes=400_000)
        except (FileNotFoundError, PermissionError) as e:
            raise BadRequest(str(e))
        if not scan["files"]:
            raise BadRequest("No source files found there (binary, ignored and very large files are skipped).")
        files = self._file_entries(scan)
        rec = {"name": spec.get("name") or name, "source": {"kind": kind, "path": str(root), "project_id": spec.get("project_id")},
               "root": str(root), "files": files, "skipped": scan["skipped"], "truncated": scan["truncated"],
               "findings": [], "status": "scanned", "options": {}, "stats": {}}
        return self.store.put("reviews", rec, rid)

    @staticmethod
    def _file_entries(scan: dict, old: dict = None) -> list:
        """The review's list of files from a folder scan. Files reviewed before keep whether they were selected."""
        files = []
        for f in scan["files"]:
            ext = Path(f["path"]).suffix.lower()
            is_code = (ext in CODE_EXTS and ext not in (".json", ".xml", ".lock", ".css", ".scss", ".less", ".ipynb", ".diff", ".patch")) \
                or Path(f["path"]).name.lower() in ("dockerfile", "makefile")
            is_test = bool(re.search(r"(^|/)(tests?|__tests__|spec)/|(_test|\.test|\.spec)\.", f["path"]))
            before = (old or {}).get(f["path"])
            files.append({"path": f["path"], "size": f["size"], "lang": LANGS.get(ext, ext[1:].upper() or "Text"),
                          "tokens": max(1, f["size"] // 4), "selected": before["selected"] if before else is_code and not is_test,
                          "status": "pending", "findings": 0})
        return files

    def rescan(self, rid: str) -> dict:
        """Look at a folder review's folder again (a routine reviews it again): new files are added, gone ones dropped,
        and files seen before keep whether they were selected."""
        rec = self._get(rid)
        if (rec.get("source") or {}).get("kind") == "zip":
            return rec
        try:
            scan = scan_folder(Path(rec["root"]), [], [], max_files=3000, max_bytes=400_000)
        except (FileNotFoundError, PermissionError) as e:
            raise BadRequest(str(e))
        if not scan["files"]:
            raise BadRequest(f"No source files found in {rec['root']} any more.")
        files = self._file_entries(scan, {f["path"]: f for f in rec.get("files", [])})
        return self.store.update("reviews", rid, lambda r: r.update(files=files, skipped=scan["skipped"], truncated=scan["truncated"]))

    @staticmethod
    def _unzip(zpath: Path, dest: Path):
        dest.mkdir(parents=True, exist_ok=True)
        total = 0
        try:
            with zipfile.ZipFile(zpath) as z:
                members = z.infolist()
                if len(members) > 30000:
                    raise BadRequest("That ZIP has too many files.")
                for m in members:
                    name = m.filename.replace("\\", "/")
                    if m.is_dir() or name.startswith("/") or ".." in name.split("/") or name.startswith("__MACOSX/"):
                        continue
                    total += m.file_size
                    if total > 300 * 1024 * 1024:
                        raise BadRequest("That ZIP unpacks to more than 300 MB.")
                    target = (dest / name).resolve()
                    if not _inside(target, dest.resolve()):
                        continue
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with z.open(m) as src, open(target, "wb") as out:
                        shutil.copyfileobj(src, out)
        except zipfile.BadZipFile:
            raise BadRequest("That file isn't a valid ZIP archive.")
        # a ZIP of a single top folder: review inside it
        entries = [p for p in dest.iterdir()]
        if len(entries) == 1 and entries[0].is_dir():
            inner = entries[0]
            for p in inner.iterdir():
                p.rename(dest / p.name)
            inner.rmdir()

    def select(self, rid: str, paths: list):
        wanted = set(paths)
        self.store.update("reviews", rid, lambda r: [f.update(selected=f["path"] in wanted) for f in r.get("files", [])])

    def delete(self, rid: str):
        job = self.jobs.running("review", review=rid)
        if job:
            self.jobs.cancel(job.id)
        self.store.delete("reviews", rid)

    def mark(self, rid: str, fid: str, state: str):
        if state not in ("open", "false_positive", "fixed", "accepted"):
            raise BadRequest("Unknown state")
        self.store.update("reviews", rid, lambda r: [f.update(state=state) for f in r.get("findings", []) if f.get("id") == fid])

    def code(self, rid: str, path: str, start: int, end: int) -> dict:
        rec = self._get(rid)
        root = Path(rec["root"]).resolve()
        target = (root / path).resolve()
        if not _inside(target, root) or not target.is_file():
            raise BadRequest("That file isn't part of the review.")
        lines = read_text(target, 2_000_000).split("\n")
        lo, hi = max(1, start), min(len(lines), max(start, end))
        return {"path": path, "start": lo, "end": hi, "total": len(lines), "lines": lines[lo - 1:hi]}

    # -- running ----------------------------------------------------------------------------
    def start(self, rid: str, options: dict, title: str = None, meta: dict = None):
        if self.jobs.running("review", review=rid):
            raise BadRequest("This review is already running.")
        rec = self._get(rid)
        if isinstance(options.get("files"), list):
            self.select(rid, [str(p) for p in options["files"]])
        opts = {"model": str(options.get("model") or "default"), "focus": options.get("focus") if options.get("focus") in FOCUS else "security",
                "thinking": bool(options.get("thinking")), "extra": str(options.get("extra") or "")[:4000]}
        resume = bool(options.get("resume"))

        def apply(r):
            r["options"] = opts
            r["status"] = "running"
            r.pop("stop_reason", None)
            if not resume:
                r["findings"] = []
                r["summary"] = None
                for f in r.get("files", []):
                    f.update(status="pending", findings=0, error="")
        self.store.update("reviews", rid, apply)
        return self.jobs.start("review", title or f"Reviewing {rec.get('name')}", lambda job: self._run(job, rid), dict(meta or {}, review=rid))

    def _overview(self, rec: dict, root: Path) -> str:
        paths = [f["path"] for f in rec.get("files", [])][:200]
        readme = ""
        for name in ("README.md", "README.rst", "README.txt", "README"):
            p = root / name
            if p.is_file():
                readme = read_text(p, 4000)[:1500]
                break
        return "Project files:\n" + "\n".join(paths) + (f"\n\nREADME (excerpt):\n{readme}" if readme else "")

    def _chat(self, job, info, model, msgs, live=None, **kw):
        """A streamed device.chat (_stream_chat) that tells a failed request apart from a device that went away.

        If the device still answers, the request itself failed and the error is raised as usual.
        If it doesn't, wait up to OUTAGE_WAIT for it to come back (a network blip), else raise DeviceGone.
        """
        try:
            return _watched(job, info, _stream_chat, job, info, model, msgs, live, **kw)
        except DeviceError as e:
            if device_up(info):
                raise
            first = e
        job.update(message="Your Tiiny stopped answering. Waiting for it to come back…", log=f"  Lost the device: {first}")
        deadline = time.time() + OUTAGE_WAIT
        while time.time() < deadline:
            job.check()
            time.sleep(5)
            if device_up(info):
                job.update(log="  The device is back; carrying on.")
                return _watched(job, info, _stream_chat, job, info, model, msgs, live, **kw)
        raise DeviceGone(str(first))

    def _run(self, job, rid: str):
        try:
            return self._run_files(job, rid)
        except DeviceGone as e:
            rec = self._get(rid)
            done = len([f for f in rec.get("files", []) if f.get("status") == "done"])
            total = len([f for f in rec.get("files", []) if f.get("selected")])
            answered = re.search(r"answered “([^”]+)”", str(e))
            cause = f"it answered “{answered.group(1)}”" if answered else str(e)[:160]
            reason = (f"Your Tiiny stopped answering after {done} of {total} files ({cause}). If it restarted or lost power, "
                      "log in to unlock it, then press Resume to carry on where the review stopped.")
            # Leave the status at "running": with no job behind it, get() reports it as interrupted, with Resume.
            self.store.update("reviews", rid, lambda r: r.update(stop_reason=reason))
            raise DeviceError(reason) from None

    def _run_files(self, job, rid: str):
        rec = self._get(rid)
        info = self.devconn.resolve()
        opts = rec["options"]
        root = Path(rec["root"])
        model = opts["model"]
        try:   # a routine's review may unload models loaded just for a moment, never yours (npu.py: "borrowed")
            npu.ensure_ready(model, policy="borrowed" if job.meta.get("routine") else "fits", job=job, info=info)
        except DeviceError as e:
            if not device_up(info):
                raise DeviceGone(str(e)) from None
            raise
        overview = self._overview(rec, root)
        system = SYSTEM.format(focus=FOCUS[opts["focus"]]) + (f"\n\nExtra instructions from the user:\n{opts['extra']}" if opts["extra"] else "")
        todo = [f for f in rec["files"] if f.get("selected") and f.get("status") != "done"]
        total = len([f for f in rec["files"] if f.get("selected")])
        done_before = total - len(todo)
        t_start = time.time()
        tokens_in = tokens_out = 0
        for n, f in enumerate(todo, 1):
            job.check()
            path = f["path"]
            job.update(message=f"Reviewing {path} ({done_before + n} of {total})", progress=(done_before + n - 1) / max(1, total),
                       log=f"Reviewing {path}")
            try:
                text = read_text(root / path, 2_000_000)
            except OSError as e:
                self._file_done(rid, path, [], f"Couldn't read it: {e}")
                continue
            findings = secrets_scan(path, text)
            lines = text.split("\n")
            error = ""
            windows = _windows(lines)
            for part, (lo, hi) in enumerate(windows, 1):
                job.check()
                # progress counts parts, so a big file moves the bar too; the time left follows from it
                done_frac = (n - 1 + (part - 1) / len(windows)) / len(todo)
                elapsed = time.time() - t_start
                job.meta["eta"] = elapsed / done_frac * (1 - done_frac) if done_frac > 0.02 and elapsed > 5 else None
                where = f"part {part} of {len(windows)} (lines {lo}–{hi})" if len(windows) > 1 else f"lines 1–{len(lines)}"
                live = {"phase": "reviewing", "file": path, "file_n": done_before + n, "files": total, "part": part,
                        "parts": len(windows), "lines": f"{lo}–{hi}"}
                job.set_live(dict(live, text="", log=list(job.log[-6:])))
                job.update(message=f"Reading {path}, {where}",
                           progress=(done_before + (n - 1) + (part - 1) / len(windows)) / max(1, total))
                user = (f"{overview}\n\nFile: {path} ({f.get('lang')})\nLines {lo}–{hi} of {len(lines)}\n\n"
                        f"```\n{_numbered(lines, lo, hi)}\n```")
                msgs = [{"role": "system", "content": system}, {"role": "user", "content": user}]
                try:
                    out = self._chat(job, info, model, msgs, live, thinking=opts["thinking"], max_tokens=1600, temperature=0.1, timeout=900)
                except DeviceError as e:
                    error = str(e)
                    job.update(log=f"  {path}: {e}")
                    continue
                tokens_in += (out["usage"] or {}).get("prompt_tokens", 0)
                tokens_out += (out["usage"] or {}).get("completion_tokens", 0)
                data = _extract_json(out["content"])
                if data is None:  # one repair attempt
                    msgs += [{"role": "assistant", "content": out["content"][:6000]},
                             {"role": "user", "content": 'That was not valid JSON. Reply again with only the JSON object {"findings": [...]}.'}]
                    try:
                        job.update(message=f"Asking again for {path}: the answer wasn't readable")
                        out = self._chat(job, info, model, msgs, dict(live, phase="repair"), thinking=False, max_tokens=1600,
                                         temperature=0, timeout=600)
                        data = _extract_json(out["content"])
                    except DeviceError:
                        data = None
                if data is None:
                    error = "The model's answer couldn't be read for part of this file."
                    continue
                for raw in data.get("findings", []) if isinstance(data.get("findings"), list) else []:
                    nf = _norm_finding(raw, path, lo, hi, lines)
                    if nf and not any(_dupe(nf, x) for x in findings):
                        findings.append(nf)
            for pf in risky_calls_scan(path, text):  # deterministic hints the model may have missed
                if not any(abs(pf["line_start"] - x["line_start"]) <= 2 and (x["category"].lower() == pf["category"].lower() or x["source"] == "ai")
                           for x in findings):
                    findings.append(pf)
            self._check_findings(job, path, lines, findings)
            for x in findings:
                x["id"] = new_id("f")
                x["state"] = "open"
            self._file_done(rid, path, findings, error)
            job.update(log=f"  {path}: {len(findings)} finding(s)")
        job.update(message="Writing the summary…", progress=0.98)
        self._summarize(info, rid, model, job)
        stats = {"seconds": round(time.time() - t_start), "tokens_in": tokens_in, "tokens_out": tokens_out}
        self.store.update("reviews", rid, lambda r: r.update(status="done", stats=stats, finished=now()))
        rec = self._get(rid)
        n = len(rec.get("findings", []))
        job.set_live(None)
        job.update(message=f"Done: {n} finding(s) in {total} file(s)", progress=1)
        return {"findings": n, "files": total}

    def _check_findings(self, job, path, lines, findings):
        """A decision model's view of each AI finding: how likely it's a real problem (f["likely"], 0..1). The review
        works the same without one (System → Decision models, no model, or it doesn't fit next to the review model)."""
        ai = [f for f in findings if f.get("source") == "ai"][:decide.MAX_QUESTIONS]
        if not ai:
            return
        if len(lines) <= 1500:
            code = _numbered(lines, 1, len(lines))
        else:  # big file: the parts around the findings
            spans = []
            for lo, hi in sorted((max(1, f["line_start"] - 60), min(len(lines), f["line_end"] + 60)) for f in ai):
                if spans and lo <= spans[-1][1] + 1:
                    spans[-1][1] = max(spans[-1][1], hi)
                else:
                    spans.append([lo, hi])
            code = "\n…\n".join(_numbered(lines, lo, hi) for lo, hi in spans)
        questions = {f"f{i}": {"type": "noul", "instructions": (
            f"A code reviewer says lines {f['line_start']}–{f['line_end']} have this problem: {f['title']}. "
            f"{str(f.get('explanation') or '')[:700]} Is that a real problem in this code?")} for i, f in enumerate(ai)}
        job.update(message=f"Checking {len(ai)} finding{'s' if len(ai) != 1 else ''} in {path} with a decision model…")
        job.set_live({"phase": "checking", "file": path, "findings": len(ai), "text": "", "log": list(job.log[-6:])})
        try:
            out = decide.decide(self.devconn, None, "review_check", f"File: {path}\n\n```\n{code}\n```", questions, timeout=600)
        except decide.Unavailable as e:
            job.update(log=f"  {path}: findings not double-checked ({e})")
            return
        for i, f in enumerate(ai):
            p = out["answers"].get(f"f{i}", {}).get("yes")
            if p is not None:
                f["likely"] = round(p, 3)
        job.update(log=f"  {path}: findings checked by {decide.short(out['model'])}")

    def _file_done(self, rid, path, findings, error):
        def apply(r):
            for f in r.get("files", []):
                if f["path"] == path:
                    f.update(status="done" if not error or findings else "error", findings=len(findings), error=error)
            r["findings"] = [x for x in r.get("findings", []) if x["path"] != path] + findings
        self.store.update("reviews", rid, apply)

    def _summarize(self, info, rid, model, job=None):
        rec = self._get(rid)
        findings = [f for f in rec.get("findings", []) if f.get("state") != "false_positive"]
        order = {s: i for i, s in enumerate(SEVERITIES)}
        findings.sort(key=lambda f: (order.get(f["severity"], 9), f["path"]))
        if not findings:
            md = "No problems were found in the reviewed files. A local model can miss things, so treat this as a first pass, not a guarantee."
        else:
            lines = [f"- [{f['severity']}] {f['category']}: {f['title']} ({f['path']}:{f['line_start']})" for f in findings[:80]]
            msgs = [{"role": "system", "content": "You write short, practical security review summaries for developers. Markdown, under 250 words."},
                    {"role": "user", "content": f"Project: {rec.get('name')}\n{len(findings)} findings:\n" + "\n".join(lines) +
                     "\n\nWrite: one sentence on overall risk, then 'Fix first' with the 3-5 most important items (file and why), "
                     "then 'Themes' with recurring patterns. Don't invent findings that aren't listed."}]
            try:
                if job is not None:
                    md = _stream_chat(job, info, model, msgs, {"phase": "summary"}, thinking=False, max_tokens=700, temperature=0.2,
                                      timeout=600)["content"]
                else:
                    md = device.chat(info, model, msgs, thinking=False, max_tokens=700, temperature=0.2, timeout=600)["content"]
            except DeviceError as e:
                md = f"(The summary couldn't be written: {e})"
        self.store.update("reviews", rid, lambda r: r.update(summary=md))

    # -- exports ------------------------------------------------------------------------------
    def export(self, rid: str, fmt: str):
        rec = self._get(rid)
        findings = [f for f in rec.get("findings", []) if f.get("state") != "false_positive"]
        order = {s: i for i, s in enumerate(SEVERITIES)}
        findings.sort(key=lambda f: (order.get(f["severity"], 9), f["path"], f["line_start"]))
        stem = re.sub(r"[^\w.-]+", "-", rec.get("name") or "review").strip("-") or "review"
        if fmt == "json":
            return f"{stem}-review.json", "application/json", json.dumps({"name": rec.get("name"), "root": rec.get("root"),
                "model": rec.get("options", {}).get("model"), "finished": rec.get("finished"), "summary": rec.get("summary"),
                "findings": findings}, indent=2).encode()
        if fmt == "sarif":
            rules, results = {}, []
            for f in findings:
                rid_ = re.sub(r"[^a-z0-9]+", "-", f["category"].lower()).strip("-") or "issue"
                rules.setdefault(rid_, {"id": rid_, "name": f["category"], "shortDescription": {"text": f["category"]}})
                results.append({"ruleId": rid_, "level": {"critical": "error", "high": "error", "medium": "warning"}.get(f["severity"], "note"),
                                "message": {"text": f"{f['title']}. {f['explanation']}".strip()},
                                "properties": {"severity": f["severity"], "confidence": f["confidence"], "suggestion": f["suggestion"], "source": f["source"]},
                                "locations": [{"physicalLocation": {"artifactLocation": {"uri": f["path"]},
                                                                    "region": {"startLine": f["line_start"], "endLine": f["line_end"]}}}]})
            sarif = {"$schema": "https://json.schemastore.org/sarif-2.1.0.json", "version": "2.1.0",
                     "runs": [{"tool": {"driver": {"name": "Tiiny Control Panel code review", "informationUri": "https://dev.tiiny.ai/",
                                                    "rules": list(rules.values())}}, "results": results}]}
            return f"{stem}.sarif", "application/sarif+json", json.dumps(sarif, indent=2).encode()
        root = Path(rec["root"])
        out = [f"# Code review: {rec.get('name')}", "",
               f"- Folder: `{rec.get('root')}`", f"- Model: {rec.get('options', {}).get('model')} · focus: {rec.get('options', {}).get('focus')}",
               f"- Reviewed: {time.strftime('%Y-%m-%d %H:%M', time.localtime(rec.get('finished') or rec.get('updated') or time.time()))}",
               f"- Findings: {len(findings)} (" + ", ".join(f"{sum(1 for f in findings if f['severity'] == s)} {s}" for s in SEVERITIES) + ")",
               "", "## Summary", "", rec.get("summary") or "(no summary)", "", "## Findings", ""]
        for f in findings:
            out += [f"### [{f['severity'].upper()}] {f['title']}", "", f"`{f['path']}` lines {f['line_start']}–{f['line_end']} · {f['category']} · confidence {f['confidence']}"
                    + (" · found by pattern" if f["source"] == "pattern" else ""), ""]
            try:
                lines = read_text(root / f["path"], 2_000_000).split("\n")
                lo, hi = max(1, f["line_start"] - 2), min(len(lines), f["line_end"] + 2)
                if f["source"] != "pattern":
                    out += ["```", "\n".join(f"{i:>4} | {lines[i - 1]}" for i in range(lo, hi + 1)), "```", ""]
            except OSError:
                pass
            out += [f["explanation"], "", f"**Fix:** {f['suggestion']}" if f["suggestion"] else "", ""]
        out += ["---", "Generated on-device by the Tiiny Control Panel. A local model can miss issues or report false positives; verify before acting."]
        return f"{stem}-review.md", "text/markdown", "\n".join(out).encode()
