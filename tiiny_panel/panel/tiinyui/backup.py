"""A backup of the panel's own data, as one ZIP file (System → Your panel's data).

The device's backup only covers what's on the Tiiny. This one covers what the panel keeps on this computer, in
~/.local/share/tiiny-ui/:
  * chats;
  * projects, with their files and search indexes;
  * meetings, the Gallery, code reviews and Studio jobs;
  * the performance history, if you ask for it.
The panel's settings come along without their secrets.

It never contains sign-in secrets (the browser key, paired phones) or API keys (the device's, Brave Search's).

Restoring either adds what's missing (the default; when both have the same item, the newer one wins) or replaces
everything. Anything a restore would overwrite is first moved to .before-restore-<time>/ in the data folder, so it
can be undone. Performance history is only ever added: days the panel already has stay as they are.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import time
import zipfile
from pathlib import Path

from . import VERSION
from .common import BadRequest, valid_id
from .store import COLLECTIONS

KIND = "tiiny-control-panel/panel-data"
FORMAT = 1
SECRET_SETTINGS = ("api_key", "search_brave_key")   # never written to a backup
STARTUP_SETTINGS = ("tiiny_bin", "cli_config")       # only set when starting the panel
STORED = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp3", ".mp4", ".m4a", ".ogg", ".opus", ".webm", ".glb", ".zip",
          ".gz", ".flac", ".mov"}                    # already compressed: stored as they are
METRICS_FILE = re.compile(r"\d{4}-\d{2}-\d{2}\.jsonl")
MAX_UNPACKED = 64 * 1024 ** 3
NAMES = {"chats": "chats", "projects": "projects", "gallery": "Gallery items", "meetings": "meetings",
         "reviews": "code reviews", "studio": "Studio jobs"}


def _files(d: Path):
    """Every regular file under `d`, without the half-written temporary files of atomic_write()."""
    if not d.is_dir():
        return []
    out = []
    for p in sorted(d.rglob("*")):
        if p.name.startswith(".") or p.is_symlink() or not p.is_file():
            continue
        out.append(p)
    return out


def summary(store) -> dict:
    """What's stored, per kind: how many items and how much space."""
    out, total = {}, 0
    for coll in sorted(COLLECTIONS):
        d = store.root / coll
        files = _files(d)
        size = sum(p.stat().st_size for p in files)
        out[coll] = {"records": len([p for p in files if p.parent == d and p.suffix == ".json"]), "bytes": size}
        total += size
    metrics = _files(store.root / "metrics")
    m = sum(p.stat().st_size for p in metrics)
    return {"collections": out, "metrics_bytes": m, "bytes": total + m, "folder": str(store.root)}


def clean_settings(settings) -> dict:
    return {k: settings.get(k) for k in settings.FIELDS if k not in SECRET_SETTINGS + STARTUP_SETTINGS}


def export(store, settings, out_path, *, metrics=False, job=None) -> dict:
    """Write the backup ZIP to `out_path`. Returns its manifest."""
    root = store.root
    entries = []
    counts = {}
    for coll in sorted(COLLECTIONS):
        d = root / coll
        files = _files(d)
        counts[coll] = {"records": len([p for p in files if p.parent == d and p.suffix == ".json"]),
                        "bytes": sum(p.stat().st_size for p in files)}
        entries += [(coll, p) for p in files]
    if metrics:
        entries += [("metrics", p) for p in _files(root / "metrics") if METRICS_FILE.fullmatch(p.name)]
    total = sum(p.stat().st_size for _, p in entries) or 1
    manifest = {"kind": KIND, "format": FORMAT, "version": VERSION, "created": time.time(), "collections": counts,
                "metrics": bool(metrics), "settings": True}
    done, last = 0, 0.0
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        z.writestr("manifest.json", json.dumps(manifest, indent=2))
        z.writestr("settings.json", json.dumps(clean_settings(settings), indent=2))
        for coll, p in entries:
            if job:
                job.check()
            arc = "data/" + p.relative_to(root).as_posix()
            ctype = zipfile.ZIP_STORED if p.suffix.lower() in STORED else zipfile.ZIP_DEFLATED
            try:
                if coll in COLLECTIONS and p.parent == root / coll and p.suffix == ".json":
                    with store.locks[coll]:   # a record is never caught half-written
                        data = p.read_bytes()
                    z.writestr(zipfile.ZipInfo.from_file(p, arc), data, compress_type=ctype)
                else:
                    z.write(p, arc, compress_type=ctype)
            except FileNotFoundError:
                continue   # deleted while the backup ran
            done += p.stat().st_size if p.exists() else 0
            if job and time.time() - last > 0.4:
                last = time.time()
                job.update(message=f"Packing… {done / 1048576:.0f} of {total / 1048576:.0f} MB", progress=done / total)
    return manifest


# -- reading a backup ----------------------------------------------------------------------------------------------
def _open(path) -> zipfile.ZipFile:
    try:
        return zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError):
        raise BadRequest("That isn't a ZIP file.")


def _manifest(z: zipfile.ZipFile) -> dict:
    try:
        man = json.loads(z.read("manifest.json"))
    except (KeyError, ValueError):
        raise BadRequest("That ZIP isn't a backup of the panel's data. (A backup of the device itself is restored under "
                         "Device backup.)")
    if not isinstance(man, dict) or man.get("kind") != KIND:
        raise BadRequest("That ZIP isn't a backup of the panel's data.")
    if not isinstance(man.get("format"), int) or man["format"] > FORMAT:
        raise BadRequest("That backup was made by a newer version of the panel. Update the panel first, then restore it.")
    return man


def _safe_parts(parts) -> bool:
    return all(p not in ("", ".", "..") and "\\" not in p and ":" not in p for p in parts)


def _plan(z: zipfile.ZipFile) -> dict:
    """Sort the backup's files into records, their files and the history; refuse unsafe names outright."""
    records, metrics, skipped, size = {}, [], 0, 0
    for i in z.infolist():
        name = i.filename
        if name.endswith("/") or name in ("manifest.json", "settings.json"):
            continue
        parts = name.split("/")
        if name.startswith("/") or not _safe_parts(parts) or stat.S_ISLNK((i.external_attr >> 16) & 0o177777):
            raise BadRequest(f"The backup has a file with an unsafe name ({name[:120]}), so nothing was restored.")
        size += i.file_size
        if size > MAX_UNPACKED:
            raise BadRequest("The backup unpacks to more than the panel accepts, so nothing was restored.")
        if parts[0] != "data" or len(parts) < 3:
            skipped += 1
            continue
        coll = parts[1]
        if coll == "metrics":
            if len(parts) == 3 and METRICS_FILE.fullmatch(parts[2]):
                metrics.append(i)
            else:
                skipped += 1
            continue
        if coll not in COLLECTIONS:   # made by a newer panel that keeps more kinds of things
            skipped += 1
            continue
        if len(parts) == 3 and parts[2].endswith(".json") and valid_id(parts[2][:-5]):
            records.setdefault(coll, {}).setdefault(parts[2][:-5], {"json": None, "files": []})["json"] = i
        elif len(parts) >= 4 and valid_id(parts[2]):
            records.setdefault(coll, {}).setdefault(parts[2], {"json": None, "files": []})["files"].append(i)
        else:
            skipped += 1
    for coll in list(records):   # a record's files without the record itself aren't restored
        for rid in [r for r, rec in records[coll].items() if rec["json"] is None]:
            skipped += len(records[coll].pop(rid)["files"])
    return {"records": records, "metrics": metrics, "skipped": skipped, "size": size}


def inspect(store, path) -> dict:
    """What a backup holds and how much of it is here already."""
    with _open(path) as z:
        man = _manifest(z)
        plan = _plan(z)
        cols = {}
        for coll in sorted(COLLECTIONS):
            recs = plan["records"].get(coll, {})
            here = sum(1 for rid in recs if (store.root / coll / f"{rid}.json").exists())
            cols[coll] = {"records": len(recs), "here": here, "name": NAMES.get(coll, coll)}
        return {"created": man.get("created"), "version": man.get("version"), "collections": cols,
                "metrics": len(plan["metrics"]), "settings": "settings.json" in z.namelist(),
                "skipped": plan["skipped"], "bytes": plan["size"]}


# -- restoring -----------------------------------------------------------------------------------------------------
def _updated(raw: bytes) -> float:
    try:
        v = json.loads(raw).get("updated")
        return float(v) if isinstance(v, (int, float)) else 0.0
    except (ValueError, AttributeError):
        return 0.0


def _write(z: zipfile.ZipFile, info, target: Path):
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.restore")
    with z.open(info) as src, open(tmp, "wb") as out:
        shutil.copyfileobj(src, out, 1 << 16)
    os.chmod(tmp, 0o600)
    os.replace(tmp, target)


def restore(store, settings, path, *, mode="merge", with_settings=False, job=None) -> dict:
    """Restore a backup: "merge" adds what's missing (the newer copy wins), "replace" swaps all the data for it.
    What it overwrites is moved to .before-restore-<time>/ first."""
    if mode not in ("merge", "replace"):
        raise BadRequest("Choose to add what's missing or to replace everything.")
    root = store.root
    aside = root / f".before-restore-{time.strftime('%Y%m%d-%H%M%S')}"
    added = replaced = kept = 0
    with _open(path) as z:
        _manifest(z)
        plan = _plan(z)
        free = shutil.disk_usage(root).free
        if plan["size"] * 1.05 + 200 * 1024 ** 2 > free:
            raise BadRequest(f"There isn't enough free disk space to restore this backup "
                             f"({plan['size'] / 1024 ** 3:.1f} GB needed).")

        def set_aside(rel: Path):
            src = root / rel
            if src.exists():
                dst = aside / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                os.replace(src, dst)

        if mode == "replace":   # the performance history isn't moved: the panel keeps writing today's file
            for coll in sorted(COLLECTIONS):
                with store.locks[coll]:
                    set_aside(Path(coll))
        todo = sum(len(r) for r in plan["records"].values()) or 1
        n, last = 0, 0.0
        for coll in sorted(plan["records"]):
            for rid, rec in sorted(plan["records"][coll].items()):
                if job:
                    job.check()
                with store.locks[coll]:
                    local = root / coll / f"{rid}.json"
                    raw = z.read(rec["json"])
                    if local.exists():
                        try:
                            mine = local.read_bytes()
                        except OSError:
                            mine = b""
                        if _updated(raw) <= _updated(mine):
                            kept += 1
                            continue
                        set_aside(Path(coll) / f"{rid}.json")
                        set_aside(Path(coll) / rid)
                        replaced += 1
                    else:
                        added += 1
                    for info in rec["files"]:
                        _write(z, info, root.joinpath(*info.filename.split("/")[1:]))
                    _write(z, rec["json"], local)
                n += 1
                if job and time.time() - last > 0.4:
                    last = time.time()
                    job.update(message=f"Restoring… {n} of {todo}", progress=n / todo)
        history = 0
        for info in plan["metrics"]:   # days that aren't here yet; a day the panel already has stays as it is
            target = root / "metrics" / info.filename.split("/")[-1]
            if not target.exists():
                _write(z, info, target)
                history += 1
        settings_done = False
        if with_settings and "settings.json" in z.namelist():
            try:
                data = json.loads(z.read("settings.json"))
            except ValueError:
                data = {}
            if isinstance(data, dict):
                settings.update({k: v for k, v in data.items()
                                 if k in settings.FIELDS and k not in SECRET_SETTINGS + STARTUP_SETTINGS})
                settings_done = True
    return {"added": added, "replaced": replaced, "kept": kept, "history_days": history, "settings": settings_done,
            "skipped": plan["skipped"], "aside": str(aside) if aside.exists() else None}
