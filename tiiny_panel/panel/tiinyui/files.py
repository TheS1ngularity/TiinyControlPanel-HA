"""Reading folders on this computer: text-file detection, .gitignore-aware scanning."""

from __future__ import annotations

import fnmatch
import os
from pathlib import Path

TEXT_EXTS = {
    ".txt", ".md", ".markdown", ".rst", ".adoc", ".org", ".tex", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml",
    ".toml", ".ini", ".cfg", ".conf", ".env", ".properties", ".xml", ".html", ".htm", ".css", ".scss", ".less",
    ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".py", ".pyi", ".rb", ".php", ".java", ".kt",
    ".kts", ".scala", ".groovy", ".gradle", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".cs", ".go", ".rs",
    ".swift", ".m", ".mm", ".r", ".jl", ".lua", ".pl", ".pm", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat",
    ".cmd", ".sql", ".graphql", ".gql", ".proto", ".dart", ".ex", ".exs", ".erl", ".hs", ".ml", ".fs", ".clj",
    ".nim", ".zig", ".v", ".sol", ".tf", ".hcl", ".nix", ".dockerfile", ".make", ".mk", ".cmake", ".log", ".srt",
    ".vtt", ".diff", ".patch", ".ipynb",
}
TEXT_NAMES = {"dockerfile", "makefile", "readme", "license", "changelog", "gemfile", "rakefile", "procfile",
              "vagrantfile", "jenkinsfile", ".gitignore", ".dockerignore", ".editorconfig"}
DEFAULT_EXCLUDES = [
    ".git/", ".hg/", ".svn/", "node_modules/", "bower_components/", "vendor/", "dist/", "build/", "out/", "target/",
    ".venv/", "venv/", "env/", "__pycache__/", ".mypy_cache/", ".pytest_cache/", ".tox/", ".next/", ".nuxt/",
    ".cache/", "coverage/", ".idea/", ".vscode/", ".gradle/", "*.min.js", "*.min.css", "*.map", "*.lock",
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "Cargo.lock", "composer.lock", "go.sum",
    "*.pyc", "*.class", "*.o", "*.so", "*.dll", "*.exe", "*.bin", "*.zip", "*.tar", "*.gz", "*.7z", "*.png", "*.jpg",
    "*.jpeg", "*.gif", "*.webp", "*.ico", "*.pdf", "*.mp3", "*.mp4", "*.wav", "*.woff", "*.woff2", "*.ttf", "*.eot",
]
CODE_EXTS = TEXT_EXTS - {".txt", ".md", ".markdown", ".rst", ".adoc", ".org", ".tex", ".csv", ".tsv", ".log", ".srt", ".vtt"}


def looks_textual(path: Path, sample: int = 8192) -> bool:
    name = path.name.lower()
    if path.suffix.lower() in TEXT_EXTS or name in TEXT_NAMES:
        return True
    try:
        with open(path, "rb") as f:
            head = f.read(sample)
    except OSError:
        return False
    if not head or b"\x00" in head:
        return False
    try:
        head.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def read_text(path: Path, limit: int = 2_000_000) -> str:
    with open(path, "rb") as f:
        raw = f.read(limit)
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16", "replace")
    return raw.decode("utf-8", "replace").replace("\r\n", "\n")


class _Ignore:
    """A small subset of .gitignore semantics: globs, dir/ patterns, /anchored, !negation, nested files."""

    def __init__(self, patterns=(), base=""):
        self.rules = []
        for p in patterns:
            self.add(p, base)

    def add(self, pattern: str, base: str = ""):
        p = pattern.strip()
        if not p or p.startswith("#"):
            return
        neg = p.startswith("!")
        if neg:
            p = p[1:]
        dir_only = p.endswith("/")
        p = p.rstrip("/")
        anchored = p.startswith("/") or "/" in p
        p = p.lstrip("/")
        self.rules.append((neg, dir_only, anchored, base, p))

    def ignored(self, rel: str, is_dir: bool) -> bool:
        result = False
        name = rel.rsplit("/", 1)[-1]
        for neg, dir_only, anchored, base, p in self.rules:
            if dir_only and not is_dir:
                continue
            if base and not (rel == base or rel.startswith(base + "/")):
                continue
            target = rel[len(base) + 1:] if base else rel
            hit = fnmatch.fnmatch(target, p) or fnmatch.fnmatch(target, p + "/*") if anchored else fnmatch.fnmatch(name, p)
            if hit:
                result = not neg
        return result


def scan_folder(root, include=None, exclude=None, max_files: int = 5000, max_bytes: int = 200_000,
                use_gitignore: bool = True) -> dict:
    """List readable text files under root. Returns {'files': [...], 'skipped': {...reason: count}, 'truncated'}."""
    root = Path(root).expanduser().resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"{root} is not a folder")
    rules = _Ignore(DEFAULT_EXCLUDES + list(exclude or []))
    includes = [p.strip() for p in (include or []) if p.strip()]
    files, skipped, truncated = [], {}, False

    def skip(reason):
        skipped[reason] = skipped.get(reason, 0) + 1

    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        rel_dir = os.path.relpath(dirpath, root).replace(os.sep, "/")
        rel_dir = "" if rel_dir == "." else rel_dir
        if use_gitignore and ".gitignore" in filenames:
            try:
                for line in (Path(dirpath) / ".gitignore").read_text(errors="replace").splitlines():
                    rules.add(line, rel_dir)
            except OSError:
                pass
        keep = []
        for d in sorted(dirnames):
            rel = f"{rel_dir}/{d}" if rel_dir else d
            if rules.ignored(rel, True) or os.path.islink(os.path.join(dirpath, d)):
                skip("ignored folder")
            else:
                keep.append(d)
        dirnames[:] = keep
        for fn in sorted(filenames):
            rel = f"{rel_dir}/{fn}" if rel_dir else fn
            p = Path(dirpath) / fn
            if rules.ignored(rel, False):
                skip("ignored")
                continue
            if includes and not any(fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(fn, pat) for pat in includes):
                skip("not included")
                continue
            try:
                st = p.lstat()
            except OSError:
                skip("unreadable")
                continue
            if not os.path.isfile(p) or os.path.islink(p):
                skip("not a regular file")
                continue
            if st.st_size > max_bytes:
                skip("too large")
                continue
            if not looks_textual(p):
                skip("binary")
                continue
            if len(files) >= max_files:
                truncated = True
                break
            files.append({"path": rel, "size": st.st_size, "mtime": st.st_mtime})
        if truncated:
            break
    return {"root": str(root), "files": files, "skipped": skipped, "truncated": truncated}
