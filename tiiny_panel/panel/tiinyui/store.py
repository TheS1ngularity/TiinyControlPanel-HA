"""Tiny JSON document store: one file per record, under ~/.local/share/tiiny-ui/<collection>/."""

from __future__ import annotations

import json
import shutil
import threading
from collections import defaultdict
from pathlib import Path

from .common import BadRequest, atomic_write, new_id, now, valid_id

COLLECTIONS = {"chats", "projects", "gallery", "meetings", "reviews", "studio", "routines"}


class Store:
    def __init__(self, root: Path):
        self.root = root
        self.locks = defaultdict(threading.RLock)

    def _dir(self, coll: str) -> Path:
        if coll not in COLLECTIONS:
            raise BadRequest(f"Unknown collection {coll!r}")
        d = self.root / coll
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _path(self, coll: str, rid: str) -> Path:
        if not valid_id(rid):
            raise BadRequest("Invalid id")
        return self._dir(coll) / f"{rid}.json"

    def blob_dir(self, coll: str, rid: str, create=True) -> Path:
        """Folder for files that belong to a record (images, indexes, ...)."""
        if not valid_id(rid):
            raise BadRequest("Invalid id")
        d = self._dir(coll) / rid
        if create:
            d.mkdir(parents=True, exist_ok=True)
        return d

    def list(self, coll: str, fields=None, where=None) -> list:
        out = []
        with self.locks[coll]:
            for p in self._dir(coll).glob("*.json"):
                try:
                    rec = json.loads(p.read_text())
                except (OSError, ValueError):
                    continue
                if where and any(rec.get(k) != v for k, v in where.items()):
                    continue
                out.append({k: rec.get(k) for k in fields} if fields else rec)
        out.sort(key=lambda r: r.get("updated") or 0, reverse=True)
        return out

    def get(self, coll: str, rid: str):
        with self.locks[coll]:
            p = self._path(coll, rid)
            try:
                return json.loads(p.read_text())
            except FileNotFoundError:
                return None
            except ValueError:
                return None

    def put(self, coll: str, rec: dict, rid: str = None) -> dict:
        rid = rid or rec.get("id") or new_id(coll[0])
        with self.locks[coll]:
            p = self._path(coll, rid)
            old = None
            if p.exists():
                try:
                    old = json.loads(p.read_text())
                except (OSError, ValueError):
                    old = None
            rec = dict(rec, id=rid)
            rec["created"] = (old or {}).get("created") or rec.get("created") or now()
            rec["updated"] = now()
            atomic_write(p, json.dumps(rec, ensure_ascii=False))
            return rec

    def update(self, coll: str, rid: str, fn) -> dict:
        """Read-modify-write under the collection lock. fn(record) mutates or returns a record."""
        with self.locks[coll]:
            rec = self.get(coll, rid)
            if rec is None:
                raise BadRequest("Not found")
            res = fn(rec)
            return self.put(coll, res if isinstance(res, dict) else rec, rid)

    def delete(self, coll: str, rid: str) -> bool:
        with self.locks[coll]:
            p = self._path(coll, rid)
            existed = p.exists()
            if existed:
                p.unlink()
            d = self._dir(coll) / rid
            if d.is_dir():
                shutil.rmtree(d, ignore_errors=True)
            return existed
