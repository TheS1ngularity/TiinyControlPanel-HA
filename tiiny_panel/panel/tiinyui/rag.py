"""Chunking text and searching it by meaning with embeddings from the device."""

from __future__ import annotations

import array
import json
import math
import re
from pathlib import Path

from .common import atomic_write

CHUNK_CHARS = 2000     # about 500 tokens
OVERLAP_CHARS = 240


def chunk_text(text: str, code: bool = False, max_chars: int = CHUNK_CHARS, overlap: int = OVERLAP_CHARS) -> list:
    """Split text into passages with 1-based line ranges: [{'text', 'start_line', 'end_line', 'heading'}]."""
    lines = text.split("\n")
    chunks, buf, buf_len, start, heading = [], [], 0, 1, ""
    current_heading = ""

    def flush(end_line):
        nonlocal buf, buf_len, start
        body = "\n".join(buf).strip()
        if body:
            chunks.append({"text": body, "start_line": start, "end_line": end_line, "heading": heading})
        # overlap: keep the tail lines
        keep, size = [], 0
        for l in reversed(buf):
            if size + len(l) > overlap:
                break
            keep.insert(0, l)
            size += len(l) + 1
        buf, buf_len = keep, size
        start = end_line - len(keep) + 1

    for idx, line in enumerate(lines, 1):
        is_heading = (not code and re.match(r"^#{1,6}\s+\S", line)) or (code and re.match(r"^(def |class |func |function |export |public |private |fn |impl |struct |interface |@)", line))
        if is_heading and buf_len > max_chars * 0.4:
            flush(idx - 1)
        if not code and re.match(r"^#{1,6}\s+\S", line):
            current_heading = line.lstrip("#").strip()[:120]
        if not buf:
            heading = current_heading
            start = idx
        while len(line) > max_chars:  # very long line (minified text, tables)
            buf.append(line[:max_chars])
            buf_len += max_chars
            line = line[max_chars:]
            flush(idx)
        buf.append(line)
        buf_len += len(line) + 1
        if buf_len >= max_chars:
            # prefer to break at a blank line within the last part of the buffer
            flush(idx)
            heading = current_heading
    flush(len(lines))
    return [c for c in chunks if len(c["text"]) > 20 or len(chunks) == 1]


def _normalize(vec) -> array.array:
    n = math.sqrt(sum(x * x for x in vec)) or 1.0
    return array.array("f", (x / n for x in vec))


class VectorIndex:
    """Passages plus unit-length float32 vectors, saved as chunks.json + vectors.f32 in a folder."""

    def __init__(self, folder: Path):
        self.folder = Path(folder)
        self.chunks = []
        self.vectors = []
        self.meta = {"model": "", "dims": 0, "sources": {}}

    @classmethod
    def load(cls, folder: Path) -> "VectorIndex":
        idx = cls(folder)
        try:
            idx.meta = json.loads((idx.folder / "meta.json").read_text())
            idx.chunks = json.loads((idx.folder / "chunks.json").read_text())
            raw = array.array("f")
            raw.frombytes((idx.folder / "vectors.f32").read_bytes())
            dims = idx.meta.get("dims") or 0
            if dims and len(raw) == dims * len(idx.chunks):
                idx.vectors = [raw[i * dims:(i + 1) * dims] for i in range(len(idx.chunks))]
            else:
                idx.chunks, idx.vectors = [], []
        except (OSError, ValueError):
            pass
        return idx

    def save(self):
        self.folder.mkdir(parents=True, exist_ok=True)
        flat = array.array("f")
        for v in self.vectors:
            flat.extend(v)
        atomic_write(self.folder / "vectors.f32", flat.tobytes())
        atomic_write(self.folder / "chunks.json", json.dumps(self.chunks, ensure_ascii=False))
        atomic_write(self.folder / "meta.json", json.dumps(self.meta))

    def replace_source(self, source_key: str, digest: str, chunks: list, vectors: list):
        keep = [(c, v) for c, v in zip(self.chunks, self.vectors) if c.get("source") != source_key]
        for c, v in zip(chunks, vectors):
            keep.append((dict(c, source=source_key), _normalize(v)))
        self.chunks = [c for c, _ in keep]
        self.vectors = [v for _, v in keep]
        if vectors:
            self.meta["dims"] = len(vectors[0])
        self.meta.setdefault("sources", {})[source_key] = {"hash": digest, "chunks": len(chunks)}

    def drop_sources(self, keep_keys: set):
        pairs = [(c, v) for c, v in zip(self.chunks, self.vectors) if c.get("source") in keep_keys]
        self.chunks = [c for c, _ in pairs]
        self.vectors = [v for _, v in pairs]
        self.meta["sources"] = {k: v for k, v in self.meta.get("sources", {}).items() if k in keep_keys}

    def search(self, query_vec, k: int = 8) -> list:
        if not self.vectors:
            return []
        q = _normalize(query_vec)
        scored = []
        for i, v in enumerate(self.vectors):
            scored.append((sum(a * b for a, b in zip(q, v)), i))
        scored.sort(reverse=True)
        return [dict(self.chunks[i], score=round(float(s), 4)) for s, i in scored[:k]]
