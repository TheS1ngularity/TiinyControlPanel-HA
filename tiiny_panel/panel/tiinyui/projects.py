"""Projects: instructions, knowledge (files, web pages, Vault files, notes, a folder) and memory,
plus the context every chat in a project receives.

Small projects are given to the model in full. Bigger ones are indexed with the device's
embedding model, and each question gets the most relevant passages, numbered so answers
can cite them. Chats can also pin files of their own: that is a hidden project tied to the chat.
"""

from __future__ import annotations

import hashlib
import json
import re
import tempfile
import threading
import time
import urllib.parse
from pathlib import Path

from . import decide, device, npu, rag, textextract, webfetch
from .common import BadRequest, DeviceError, estimate_tokens, new_id, now, safe_name
from .files import CODE_EXTS, read_text, scan_folder

CONTEXT_SIZES = {"small": 3000, "medium": 6000, "large": 12000}
MEMORY_TOKENS = 1500
MAX_FACTS = 60
EDITABLE = {"name": str, "description": str, "instructions": str, "model": str, "thinking": (bool, type(None)),
            "agent": bool, "context_size": str, "memory_enabled": bool, "embed_model": str}
QUERY_PREFIX = "Instruct: Given a question, retrieve passages that help answer it\nQuery: "


def _sha(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()


class Projects:
    def __init__(self, store, devconn, jobs, runtime):
        self.store = store
        self.devconn = devconn
        self.jobs = jobs
        self.rt = runtime
        self.memory_locks = {}

    # ------------------------------------------------------------------ records
    def _get(self, pid: str) -> dict:
        rec = self.store.get("projects", pid)
        if not rec:
            raise BadRequest("That project no longer exists.")
        return rec

    def summary(self, rec: dict) -> dict:
        docs = rec.get("docs", [])
        return {"id": rec["id"], "name": rec.get("name"), "description": rec.get("description", ""),
                "docs": len(docs), "tokens": sum(d.get("tokens", 0) for d in docs), "updated": rec.get("updated"),
                "created": rec.get("created"), "model": rec.get("model", ""), "memory": len(rec.get("memory", {}).get("facts", [])),
                "hidden": rec.get("hidden", False), "chat_id": rec.get("chat_id")}

    def list(self) -> list:
        return [self.summary(p) for p in self.store.list("projects") if not p.get("hidden")]

    def get(self, pid: str) -> dict:
        rec = self._get(pid)
        rec["index_state"] = self.index_state(rec)
        job = self.jobs.running("project-index", project=pid)
        rec["index_job"] = job.info() if job else None
        return rec

    def create(self, data: dict) -> dict:
        rec = {"name": (data.get("name") or "Untitled project").strip()[:120], "description": data.get("description", "")[:2000],
               "instructions": data.get("instructions", "")[:20000], "model": data.get("model", ""), "thinking": None,
               "agent": bool(data.get("agent")), "context_size": data.get("context_size") or "medium",
               "memory_enabled": data.get("memory_enabled", True), "memory": {"facts": []}, "docs": [],
               "hidden": bool(data.get("hidden")), "chat_id": data.get("chat_id")}
        return self.store.put("projects", rec, new_id("p"))

    def update(self, pid: str, patch: dict) -> dict:
        def apply(rec):
            for k, typ in EDITABLE.items():
                if k in patch and isinstance(patch[k], typ):
                    rec[k] = patch[k][:20000] if isinstance(patch[k], str) else patch[k]
            if rec.get("context_size") not in CONTEXT_SIZES:
                rec["context_size"] = "medium"
            if isinstance(patch.get("facts"), list):
                facts = []
                for f in patch["facts"][:MAX_FACTS]:
                    if isinstance(f, dict) and isinstance(f.get("text"), str) and f["text"].strip():
                        facts.append({"id": f.get("id") or new_id("f"), "text": f["text"].strip()[:400],
                                      "created": f.get("created") or now(), "source": f.get("source", "you")})
                rec.setdefault("memory", {})["facts"] = facts
        return self.store.update("projects", pid, apply)

    def delete(self, pid: str):
        self._get(pid)
        self.store.delete("projects", pid)

    # --------------------------------------------------------------------- docs
    def _docs_dir(self, pid: str) -> Path:
        d = self.store.blob_dir("projects", pid) / "docs"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _save_doc(self, pid: str, doc: dict, text: str = None) -> dict:
        if text is not None:
            text = text.replace("\r\n", "\n").strip()
            if not text:
                raise BadRequest("There's no text in that.")
            (self._docs_dir(pid) / f"{doc['id']}.txt").write_text(text, encoding="utf-8")
            doc.update(chars=len(text), tokens=estimate_tokens(text), hash=_sha(text))
        doc.setdefault("added", now())

        def apply(rec):
            docs = [d for d in rec.get("docs", []) if d["id"] != doc["id"]]
            docs.append(doc)
            rec["docs"] = docs
        self.store.update("projects", pid, apply)
        return doc

    def add_doc(self, pid: str, spec: dict, allow_private: bool = True) -> dict:
        self._get(pid)
        kind = spec.get("kind")
        doc = {"id": new_id("d"), "kind": kind}
        if kind == "upload":
            rec = self.rt.get_file(str(spec.get("file_id", "")))
            if not rec:
                raise BadRequest("That upload has expired. Please add the file again.")
            try:
                out = textextract.extract(rec["path"], rec["name"])
            except textextract.Unsupported as e:
                raise BadRequest(f"{rec['name']}: {e}")
            doc.update(kind="file", name=rec["name"], title=out["title"], filetype=out["kind"])
            return self._save_doc(pid, doc, out["text"])
        if kind == "url":
            page = webfetch.fetch(spec.get("url", ""), allow_private=allow_private)
            doc.update(kind="web", name=page["title"][:160], title=page["title"], url=page["final_url"])
            return self._save_doc(pid, doc, page["text"])
        if kind == "note":
            title = (spec.get("title") or "Note").strip()[:160]
            doc.update(kind="note", name=title, title=title)
            return self._save_doc(pid, doc, spec.get("text", ""))
        if kind == "vault":
            sid, fname = str(spec.get("source_id", "")), safe_name(spec.get("filename", "")) or "file"
            info = self.devconn.resolve()
            conn, resp = device.device_open(info, "kb", "GET", f"/kb/files/{urllib.parse.quote(sid)}", timeout=300)
            try:
                if resp.status != 200:
                    raise BadRequest(f"The Vault couldn't send {fname} (HTTP {resp.status}).")
                with tempfile.TemporaryDirectory() as tmp:
                    path = Path(tmp) / fname
                    path.write_bytes(resp.read(200 * 1024 * 1024))
                    try:
                        out = textextract.extract(path, fname)
                    except textextract.Unsupported as e:
                        raise BadRequest(f"{fname}: {e}")
            finally:
                conn.close()
            doc.update(kind="vault", name=fname, title=out["title"], source_id=sid, filetype=out["kind"])
            return self._save_doc(pid, doc, out["text"])
        if kind == "folder":
            path = Path(str(spec.get("path", ""))).expanduser()
            include = [p for p in spec.get("include", []) if isinstance(p, str)][:50]
            exclude = [p for p in spec.get("exclude", []) if isinstance(p, str)][:50]
            try:
                scan = scan_folder(path, include, exclude)
            except (FileNotFoundError, PermissionError) as e:
                raise BadRequest(str(e))
            if not scan["files"]:
                raise BadRequest("No readable text files in that folder (after skipping ignored and binary files).")
            tokens = sum(f["size"] for f in scan["files"]) // 4
            doc.update(kind="folder", name=Path(scan["root"]).name or scan["root"], path=scan["root"], include=include,
                       exclude=exclude, files=len(scan["files"]), tokens=tokens, chars=tokens * 4,
                       truncated=scan["truncated"], hash="")
            return self._save_doc(pid, doc)
        raise BadRequest("Unknown kind of knowledge")

    def remove_doc(self, pid: str, doc_id: str):
        def apply(rec):
            rec["docs"] = [d for d in rec.get("docs", []) if d["id"] != doc_id]
        self.store.update("projects", pid, apply)
        p = self._docs_dir(pid) / f"{doc_id}.txt"
        if p.exists():
            p.unlink()

    def doc_text(self, pid: str, doc_id: str, limit: int = 200_000) -> dict:
        rec = self._get(pid)
        doc = next((d for d in rec.get("docs", []) if d["id"] == doc_id), None)
        if not doc:
            raise BadRequest("That file isn't in this project any more.")
        if doc["kind"] == "folder":
            scan = scan_folder(doc["path"], doc.get("include"), doc.get("exclude"))
            listing = "\n".join(f"{f['path']}  ({f['size']} bytes)" for f in scan["files"])
            return {"doc": doc, "text": f"Folder {doc['path']} ({len(scan['files'])} files):\n\n{listing}"[:limit]}
        p = self._docs_dir(pid) / f"{doc_id}.txt"
        text = p.read_text(encoding="utf-8") if p.exists() else ""
        return {"doc": doc, "text": text[:limit], "truncated": len(text) > limit}

    def find_doc(self, pid: str, name: str):
        """Look a document up by (part of) its name, for the agent's read tool."""
        rec = self._get(pid)
        name_l = name.lower().strip()
        docs = rec.get("docs", [])
        exact = [d for d in docs if d.get("name", "").lower() == name_l]
        partial = [d for d in docs if name_l in d.get("name", "").lower()]
        if exact or partial:
            return (exact or partial)[0], None
        for d in docs:  # a file inside a linked folder
            if d["kind"] == "folder":
                root = Path(d["path"])
                cand = (root / name).resolve()
                try:
                    cand.relative_to(root.resolve())
                except ValueError:
                    continue
                if cand.is_file():
                    return d, cand
        return None, None

    # -------------------------------------------------------------------- index
    def _index_dir(self, pid: str) -> Path:
        return self.store.blob_dir("projects", pid) / "index"

    def _sources(self, rec: dict, folders_detail: bool = True) -> list:
        """Everything that should be in the index: [(key, digest, loader, meta)]."""
        out = []
        for d in rec.get("docs", []):
            if d["kind"] != "folder":
                ext = Path(d.get("name", "")).suffix.lower()
                path = self._docs_dir(rec["id"]) / f"{d['id']}.txt"
                out.append((d["id"], d.get("hash", ""), lambda p=path: p.read_text(encoding="utf-8") if p.exists() else "",
                            {"doc_id": d["id"], "name": d.get("name"), "kind": d["kind"], "url": d.get("url"),
                             "code": ext in CODE_EXTS}))
            elif folders_detail:
                try:
                    scan = scan_folder(d["path"], d.get("include"), d.get("exclude"))
                except (FileNotFoundError, PermissionError):
                    continue
                root = Path(scan["root"])
                for f in scan["files"]:
                    p = root / f["path"]
                    out.append((f"{d['id']}:{f['path']}", f"{f['size']}:{int(f['mtime'])}",
                                lambda p=p: read_text(p), {"doc_id": d["id"], "name": f["path"], "kind": "folder",
                                                            "path": f["path"], "folder": d["path"],
                                                            "code": Path(f["path"]).suffix.lower() in CODE_EXTS}))
        return out

    def index_state(self, rec: dict) -> dict:
        idx = rag.VectorIndex.load(self._index_dir(rec["id"]))
        sources = self._sources(rec)
        have = idx.meta.get("sources", {})
        stale = [k for k, digest, _l, _m in sources if have.get(k, {}).get("hash") != digest]
        extra = [k for k in have if k not in {s[0] for s in sources}]
        total_tokens = sum(d.get("tokens", 0) for d in rec.get("docs", []))
        budget = CONTEXT_SIZES.get(rec.get("context_size"), 6000)
        return {"model": idx.meta.get("model", ""), "chunks": len(idx.chunks), "sources": len(sources),
                "stale": len(stale) + len(extra), "indexed_at": rec.get("indexed_at"), "tokens": total_tokens,
                "fits": total_tokens <= budget and not any(d["kind"] == "folder" for d in rec.get("docs", [])),
                "needed": bool(sources) and not (total_tokens <= budget and not any(d["kind"] == "folder" for d in rec.get("docs", [])))}

    def start_index(self, pid: str):
        running = self.jobs.running("project-index", project=pid)
        if running:
            return running
        rec = self._get(pid)
        return self.jobs.start("project-index", f"Indexing {rec.get('name', 'project')}", lambda job: self._index_job(job, pid),
                               {"project": pid})

    def _index_job(self, job, pid: str):
        rec = self._get(pid)
        info = self.devconn.resolve()
        model = rec.get("embed_model") or device.pick_model(info, "embed")
        if not model:
            raise DeviceError("There's no embedding model on your device. Download one such as Qwen3-Embedding-0.6B from the model store.")
        folder = self._index_dir(pid)
        idx = rag.VectorIndex.load(folder)
        if idx.meta.get("model") and idx.meta["model"] != model:
            idx = rag.VectorIndex(folder)
        job.update(message="Looking for changes…")
        sources = self._sources(rec)
        idx.drop_sources({s[0] for s in sources})
        have = idx.meta.get("sources", {})
        todo = [s for s in sources if have.get(s[0], {}).get("hash") != s[1]]
        if not todo:
            idx.meta["model"] = model
            idx.save()
            self.store.update("projects", pid, lambda r: r.update(indexed_at=now(), embed_model=model))
            job.update(message="Everything is up to date.", progress=1)
            return {"chunks": len(idx.chunks), "updated": 0}
        npu.ensure_ready(model, policy="fits", job=job, info=info)
        idx.meta["model"] = model
        done_chunks = 0
        for n, (key, digest, loader, meta) in enumerate(todo, 1):
            job.check()
            text = loader()
            chunks = rag.chunk_text(text, code=meta.get("code", False)) if text.strip() else []
            payload = [f"{meta['name']}\n{c['heading']}\n{c['text']}".strip() for c in chunks]
            vectors = device.embed(info, model, payload, job=job) if payload else []
            idx.replace_source(key, digest, [dict(c, **{k: v for k, v in meta.items() if k != "code"}) for c in chunks], vectors)
            done_chunks += len(chunks)
            job.update(message=f"Indexed {n} of {len(todo)}: {meta['name']}", progress=n / len(todo))
            if n % 25 == 0:
                idx.save()
        idx.save()
        self.store.update("projects", pid, lambda r: r.update(indexed_at=now(), embed_model=model))
        return {"chunks": len(idx.chunks), "updated": len(todo), "new_chunks": done_chunks}

    def search(self, pid: str, query: str, k: int = 8) -> list:
        idx = rag.VectorIndex.load(self._index_dir(pid))
        if not idx.chunks:
            return []
        info = self.devconn.resolve()
        npu.ensure_ready(idx.meta["model"], policy="fits", info=info)
        qvec = device.embed(info, idx.meta["model"], [QUERY_PREFIX + query])[0]
        return idx.search(qvec, k)

    # ------------------------------------------------------------------ context
    def context(self, pid: str, question: str, size: str = None, start: int = 1) -> dict:
        rec = self._get(pid)
        budget = CONTEXT_SIZES.get(size or rec.get("context_size"), 6000)
        sections, sources = [], []
        label = "these files" if rec.get("hidden") else f"the project “{rec.get('name')}”"
        if rec.get("instructions", "").strip() and not rec.get("hidden"):
            sections.append(f"## Instructions for {label}\n{rec['instructions'].strip()}")
        facts = rec.get("memory", {}).get("facts", []) if rec.get("memory_enabled", True) else []
        if facts:
            lines, used = [], 0
            for f in facts:
                used += estimate_tokens(f["text"])
                if used > MEMORY_TOKENS:
                    break
                lines.append(f"- {f['text']}")
            sections.append("## What you know from earlier chats in this project\n" + "\n".join(lines))
        docs = rec.get("docs", [])
        state = {"mode": "none", "needs_index": False}
        if docs:
            total = sum(d.get("tokens", 0) for d in docs)
            has_folder = any(d["kind"] == "folder" for d in docs)
            if total <= budget and not has_folder:
                state["mode"] = "full"
                parts = []
                for d in docs:
                    p = self._docs_dir(pid) / f"{d['id']}.txt"
                    text = p.read_text(encoding="utf-8") if p.exists() else ""
                    n = start + len(sources)
                    sources.append({"n": n, "doc_id": d["id"], "name": d.get("name"), "kind": d["kind"], "url": d.get("url"),
                                    "start_line": 1, "end_line": text.count("\n") + 1, "text": text[:6000]})
                    parts.append(f"[{n}] {d.get('name')}\n{text}")
                sections.append(f"## Files in {label}\n\n" + "\n\n---\n\n".join(parts))
            else:
                idx = rag.VectorIndex.load(self._index_dir(pid))
                st = self.index_state(rec)
                state["needs_index"] = st["stale"] > 0 or not idx.chunks
                if idx.chunks and question.strip():
                    state["mode"] = "search"
                    try:
                        hits = self.search(pid, question, k=30)
                    except DeviceError as e:
                        hits = []
                        state["error"] = str(e)
                    used, picked = 0, []
                    # keep passages close to the best match; weak ones only slow the model down
                    floor = max(0.45, (hits[0]["score"] - 0.15) if hits else 0)
                    hits = [h for h in hits if h["score"] >= floor]
                    for h in hits:
                        if any(p["source"] == h["source"] and p["start_line"] <= h["end_line"] and h["start_line"] <= p["end_line"] for p in picked):
                            continue
                        cost = estimate_tokens(h["text"])
                        if used + cost > budget:
                            continue
                        picked.append(h)
                        used += cost
                    parts = []
                    for h in picked:
                        n = start + len(sources)
                        where = f" (lines {h['start_line']}–{h['end_line']})" if h.get("kind") == "folder" or h.get("path") else ""
                        sources.append({"n": n, "doc_id": h.get("doc_id"), "name": h.get("name"), "kind": h.get("kind"),
                                        "path": h.get("path"), "url": h.get("url"), "start_line": h["start_line"],
                                        "end_line": h["end_line"], "score": h.get("score"), "text": h["text"]})
                        parts.append(f"[{n}] {h.get('name')}{where}\n{h['text']}")
                    if parts:
                        sections.append(f"## Passages from {label} that match the question\n\n" + "\n\n---\n\n".join(parts))
                if not sources:
                    names = ", ".join(d.get("name", "") for d in docs[:30])
                    sections.append(f"## Files in {label}\n{names}\n(They aren't indexed yet, so their content isn't included.)")
        if sources:
            sections.append("When you use a numbered source above, cite it like [1] or [2][3]. "
                            "If the sources don't contain the answer, say so instead of guessing.")
        return {"system": "\n\n".join(sections), "sources": sources, **state}

    # ------------------------------------------------------------------- memory
    def start_memory_update(self, pid: str, model: str, user: str, assistant: str, chat_id: str = ""):
        rec = self._get(pid)
        if not rec.get("memory_enabled", True) or rec.get("hidden"):
            return None
        if len((user or "").strip()) < 12 and len((assistant or "").strip()) < 40:
            return None
        return self.jobs.start("project-memory", f"Updating memory for {rec.get('name')}",
                               lambda job: self._memory_job(job, pid, model, user, assistant, chat_id), {"project": pid})

    def _memory_job(self, job, pid, model, user, assistant, chat_id):
        # A decision model first: most turns hold nothing worth remembering, and then the chat model needn't run.
        try:
            out = decide.decide(self.devconn, None, "project_memory", f"User: {user[:4000]}\n\nAssistant: {assistant[:4000]}",
                                {"keep": {"type": "noul", "instructions": (
                                    "Does this exchange contain a lasting fact worth remembering for later conversations in this project: "
                                    "a decision, requirement, preference, name, number, deadline or constraint?")}}, timeout=60)
            p = out["answers"]["keep"].get("yes")
            if p is not None and p < 0.25:
                job.update(message="Nothing to remember from this turn", log=f"Skipped: {decide.short(out['model'])} saw nothing to remember ({p:.0%})")
                return {"skipped": True}
        except decide.Unavailable:
            pass
        lock = self.memory_locks.setdefault(pid, threading.Lock())
        with lock:
            rec = self._get(pid)
            facts = rec.get("memory", {}).get("facts", [])
            info = self.devconn.resolve()
            existing = "\n".join(f"{f['id']}: {f['text']}" for f in facts) or "(none yet)"
            prompt = [
                {"role": "system", "content": (
                    "You maintain a short memory for a project. Keep only durable facts that will matter in later "
                    "conversations: decisions, requirements, preferences, names, numbers, deadlines, constraints. "
                    "Skip small talk, questions, and anything already in the memory. Facts must be short, standalone sentences. "
                    'Reply with JSON only: {"add": ["fact", ...], "remove": ["id", ...]}. Use "remove" only when the new '
                    "conversation says an existing fact is wrong or outdated.")},
                {"role": "user", "content": f"Project: {rec.get('name')}\n\nCurrent memory:\n{existing}\n\n"
                                            f"New exchange:\nUser: {user[:4000]}\nAssistant: {assistant[:4000]}"},
            ]
            job.update(message="Reading the conversation…")
            out = device.chat(info, model or "default", prompt, thinking=False, max_tokens=500, temperature=0.1, timeout=300)
            m = re.search(r"\{.*\}", out["content"], re.S)
            if not m:
                return {"added": 0, "removed": 0}
            try:
                data = json.loads(m.group(0))
            except ValueError:
                return {"added": 0, "removed": 0}
            remove = {str(x) for x in data.get("remove", []) if isinstance(x, (str, int))}
            norm = lambda s: re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()
            seen = {norm(f["text"]) for f in facts if f["id"] not in remove}
            added = []
            for t in data.get("add", []):
                if isinstance(t, str) and 8 <= len(t.strip()) <= 400 and norm(t) not in seen:
                    seen.add(norm(t))
                    added.append({"id": new_id("f"), "text": t.strip(), "created": now(), "source": chat_id or "chat"})

            def apply(r):
                cur = [f for f in r.get("memory", {}).get("facts", []) if f["id"] not in remove]
                r.setdefault("memory", {})["facts"] = (cur + added)[-MAX_FACTS:]
            self.store.update("projects", pid, apply)
            job.update(message=f"Remembered {len(added)} new fact(s)")
            return {"added": len(added), "removed": len(remove), "facts": [a["text"] for a in added]}
