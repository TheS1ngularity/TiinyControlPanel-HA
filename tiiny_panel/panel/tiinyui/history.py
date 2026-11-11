"""Searching what you did before: saved chats, meetings and the Gallery.

Used by agent mode's search_my_history and open_from_history tools (both can be switched off under
System → Agent tools). Read-only. Words are matched in titles and text; results that contain every word
come first, then the newest.
"""

from __future__ import annotations

import re

from .common import BadRequest

WHERE = {"chats": ("chats",), "meetings": ("meetings",), "gallery": ("gallery",), "all": ("chats", "meetings", "gallery")}
KIND = {"chats": "chat", "meetings": "meeting", "gallery": "gallery"}
THINK_RE = re.compile(r"<think>[\s\S]*?(</think>|$)", re.I)
CHAT_CHARS = 12_000
TRANSCRIPT_CHARS = 10_000
MAX_LIMIT = 20


def _words(query: str) -> list:
    out = []
    for w in re.findall(r"[\w'’-]+", (query or "").lower()):
        w = w.strip("'’-")
        if len(w) >= 2 and w not in out:
            out.append(w)
    return out[:12]


def _link(kind: str, rid: str) -> str:
    return {"chat": f"#/chat/{rid}", "meeting": f"#/meetings/{rid}", "gallery": f"#/gallery?open={rid}"}[kind]


def _chat_messages(rec: dict) -> list:
    out = []
    for m in rec.get("messages") or []:
        if m.get("role") not in ("user", "assistant") or not isinstance(m.get("content"), str):
            continue
        text = THINK_RE.sub("", m["content"]).strip()
        if text:
            out.append((m["role"], text))
    return out


def _transcript(rec: dict) -> str:
    lines = []
    for s in rec.get("segments") or []:
        t = (s.get("text") or "").strip()
        if t:
            sec = int(s.get("start") or 0)
            lines.append(f"[{sec // 60:02d}:{sec % 60:02d}] {t}")
    return "\n".join(lines)


def _texts(coll: str, rec: dict):
    """(title, body) to search."""
    if coll == "chats":
        return rec.get("title") or "Chat", "\n".join(t for _, t in _chat_messages(rec))
    if coll == "meetings":
        return rec.get("title") or "Meeting", "\n".join(x for x in (rec.get("summary_md") or "", rec.get("notes") or "", _transcript(rec)) if x)
    return rec.get("title") or rec.get("prompt") or "Gallery item", " ".join(str(rec.get(k) or "") for k in ("prompt", "negative_prompt", "model", "kind"))


def _snippet(body: str, words: list, size: int = 120) -> str:
    low = body.lower()
    pos = min((p for p in (low.find(w) for w in words) if p >= 0), default=-1)
    if pos < 0:
        text = body[:2 * size]
        return " ".join(text.split()) + ("…" if len(body) > 2 * size else "")
    start, end = max(0, pos - size), min(len(body), pos + size)
    return ("…" if start else "") + " ".join(body[start:end].split()) + ("…" if end < len(body) else "")


def search(store, query: str, where: str = "all", exclude_chat: str = "", limit: int = 8) -> dict:
    words = _words(query)
    if not words:
        raise BadRequest("Say what to look for.")
    if where not in WHERE:
        raise BadRequest("Look in chats, meetings, gallery or all.")
    try:
        limit = max(1, min(MAX_LIMIT, int(limit or 8)))
    except (TypeError, ValueError):
        limit = 8
    found = []
    for coll in WHERE[where]:
        for rec in store.list(coll):
            if coll == "chats" and rec.get("id") == exclude_chat:
                continue
            title, body = _texts(coll, rec)
            tl, bl = title.lower(), body.lower()
            matched = [w for w in words if w in tl or w in bl]
            if not matched:
                continue
            score = sum(3 * tl.count(w) + min(bl.count(w), 20) for w in matched)
            item = {"kind": KIND[coll], "id": rec.get("id"), "title": title[:200], "date": rec.get("updated") or rec.get("created"),
                    "snippet": _snippet(body, matched) if body.strip() else "", "link": _link(KIND[coll], rec.get("id")),
                    "_rank": (len(matched), score, rec.get("updated") or 0)}
            if coll == "gallery":
                item["item_kind"] = rec.get("kind")
            elif coll == "meetings":
                item["duration"] = rec.get("duration")
            found.append(item)
    found.sort(key=lambda r: r["_rank"], reverse=True)
    complete = [r for r in found if r["_rank"][0] == len(words)]
    results = (complete or found)[:limit]
    for r in results:
        del r["_rank"]
    return {"query": " ".join(words), "where": where, "results": results, "all_words": bool(complete),
            "more": len(complete or found) > limit}


def _clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    head = limit // 3
    return f"{text[:head]}\n… ({len(text) - limit:,} characters left out) …\n{text[-(limit - head):]}"


def read(store, kind: str, rid: str) -> dict:
    coll = {"chat": "chats", "meeting": "meetings", "gallery": "gallery"}.get(kind)
    if not coll or not rid:
        raise BadRequest("Say which chat, meeting or Gallery item (kind and id from search_my_history).")
    rec = store.get(coll, rid)
    if not rec:
        raise BadRequest(f"There's no {kind} with the id {rid} any more.")
    title = rec.get("title") or rec.get("prompt") or kind.capitalize()
    out = {"kind": kind, "id": rid, "title": title, "date": rec.get("updated") or rec.get("created"), "link": _link(kind, rid)}
    if kind == "chat":
        msgs = _chat_messages(rec)
        shown = msgs[-40:]
        text = "\n\n".join(f"{'User' if role == 'user' else 'Assistant'}: {t}" for role, t in shown)
        out["text"] = (f"(the first {len(msgs) - len(shown)} messages are left out)\n\n" if len(msgs) > len(shown) else "") + _clip(text, CHAT_CHARS)
        out["messages"] = len(msgs)
    elif kind == "meeting":
        parts = []
        if rec.get("summary_md"):
            parts.append("Meeting notes:\n" + rec["summary_md"].strip())
        if (rec.get("notes") or "").strip():
            parts.append("The user's own notes:\n" + rec["notes"].strip())
        transcript = _transcript(rec)
        parts.append("Transcript:\n" + (_clip(transcript, TRANSCRIPT_CHARS) if transcript else "(none)"))
        out["text"] = "\n\n".join(parts)
        out["duration"] = rec.get("duration")
    else:
        keep = ("id", "kind", "title", "prompt", "negative_prompt", "model", "created", "width", "height", "duration", "parent_id", "files", "params")
        item = {k: rec.get(k) for k in keep}
        out["item"] = item
        lines = [f"Kind: {item['kind']}", f"Prompt: {item.get('prompt') or '(none)'}", f"Model: {item.get('model') or '?'}"]
        if item.get("width"):
            lines.append(f"Size: {item['width']}×{item['height']}")
        if item.get("parent_id"):
            lines.append(f"Made from Gallery item {item['parent_id']}")
        out["text"] = "\n".join(lines)
    return out
