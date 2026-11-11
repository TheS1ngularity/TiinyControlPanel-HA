"""Meeting notes: transcripts made in the browser (live microphone or a recording), summaries made here.

The page cuts audio into ~20 s pieces, has the device transcribe them and appends the text with
timestamps. When the meeting ends, a background job asks a chat model for an overview, key points,
decisions, action items and open questions. The result can be edited, saved to the Vault, or added
to a project's knowledge.
"""

from __future__ import annotations

import json
import re
import time

from . import decide, device, npu
from .common import BadRequest, DeviceError, estimate_tokens, safe_name

EDITABLE = ("title", "notes", "language", "asr_model", "status", "duration", "summary_md", "source", "file_name")
CHUNK_TOKENS = 9000

SYSTEM = """You turn meeting transcripts into clear, useful notes. The transcript was made by speech recognition, so expect
some mistakes and missing speaker names; fix obvious recognition errors silently, but never invent facts, names or dates.
Write in the same language as the transcript."""

FORMAT = """Reply with JSON only, in exactly this shape:
{"title": "a short title for the meeting",
 "overview": "2-4 sentences: what the meeting was about and what came out of it",
 "key_points": ["the main things discussed, one per item"],
 "decisions": ["decisions that were made"],
 "action_items": [{"task": "what needs doing", "owner": "who (only if said, else empty)", "due": "when (only if said, else empty)"}],
 "open_questions": ["questions or issues left open"]}
Use empty lists when there is nothing for a section."""


def fmt_ts(seconds: float) -> str:
    s = int(max(0, seconds or 0))
    return f"{s // 3600}:{s // 60 % 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60:02d}:{s % 60:02d}"


def transcript_text(rec: dict, stamps: bool = True) -> str:
    lines = []
    for seg in rec.get("segments") or []:
        text = (seg.get("text") or "").strip()
        if text:
            lines.append(f"[{fmt_ts(seg.get('start'))}] {text}" if stamps else text)
    return "\n".join(lines)


HIGHLIGHT_KINDS = {  # what a decision model looks for in a transcript (System → Decision models)
    "action": "Something a person will do: a task or action item, often with an owner or a date",
    "decision": "Something the people in the meeting decided or agreed on",
    "question": "A question that was raised and left open",
    "other": None,
}


# a sentence ends at . ! ? … and a space, or where the transcription left the space out ("background.It is")
SENTENCE_END = re.compile(r"(?<=[.!?…])\s+|(?<=[a-z][.!?])(?=[A-Z])")


def sentences(segments: list) -> list:
    """The transcript as sentences, each with its segment's start time (too-short fillers like "Okay." left out)."""
    out = []
    for seg in segments:
        for sent in SENTENCE_END.split(str(seg.get("text") or "").strip()):
            if len(sent.split()) >= 4:
                out.append({"start": seg.get("start") or 0, "text": sent.strip()})
    return out


def _same(text: str) -> str:
    return re.sub(r"[^\w]+", " ", text.lower()).strip()


def summary_markdown(data: dict) -> str:
    out = []
    if data.get("overview"):
        out += ["## Overview", "", str(data["overview"]).strip(), ""]
    sections = (("key_points", "Key points"), ("decisions", "Decisions"), ("open_questions", "Open questions"))
    for key, title in sections[:2]:
        items = [str(x).strip() for x in data.get(key) or [] if str(x).strip()]
        if items:
            out += [f"## {title}", ""] + [f"- {x}" for x in items] + [""]
    acts = []
    for a in data.get("action_items") or []:
        if isinstance(a, dict) and str(a.get("task", "")).strip():
            extra = ", ".join(x for x in (str(a.get("owner") or "").strip(), f"due {a['due']}".strip() if str(a.get("due") or "").strip() else "") if x)
            acts.append(f"- [ ] {a['task'].strip()}" + (f" ({extra})" if extra else ""))
        elif isinstance(a, str) and a.strip():
            acts.append(f"- [ ] {a.strip()}")
    if acts:
        out += ["## Action items", ""] + acts + [""]
    items = [str(x).strip() for x in data.get("open_questions") or [] if str(x).strip()]
    if items:
        out += ["## Open questions", ""] + [f"- {x}" for x in items] + [""]
    return "\n".join(out).strip()


def _json_from(text: str):
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", (text or "").strip(), flags=re.M)
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


class Meetings:
    def __init__(self, store, devconn, jobs, runtime, projects):
        self.store, self.devconn, self.jobs, self.rt, self.projects = store, devconn, jobs, runtime, projects

    @staticmethod
    def summary(rec: dict) -> dict:
        segs = rec.get("segments") or []
        words = sum(len((s.get("text") or "").split()) for s in segs)
        return {"id": rec["id"], "title": rec.get("title"), "created": rec.get("created"), "updated": rec.get("updated"),
                "duration": rec.get("duration"), "status": rec.get("status"), "source": rec.get("source"), "words": words,
                "has_summary": bool(rec.get("summary_md"))}

    def list(self) -> list:
        return [self.summary(r) for r in self.store.list("meetings")]

    def get(self, mid: str) -> dict:
        rec = self.store.get("meetings", mid)
        if not rec:
            raise BadRequest("That meeting no longer exists.")
        job = self.jobs.running("meeting-summary", meeting=mid) or self.jobs.running("meeting-highlights", meeting=mid)
        rec["job"] = job.info() if job else None
        return rec

    def create(self, spec: dict) -> dict:
        rec = {"title": str(spec.get("title") or "").strip()[:200] or time.strftime("Meeting %Y-%m-%d %H:%M"),
               "source": spec.get("source") if spec.get("source") in ("live", "file") else "live",
               "language": str(spec.get("language") or "")[:20], "asr_model": str(spec.get("asr_model") or ""),
               "file_name": str(spec.get("file_name") or "")[:300], "segments": [], "notes": "", "status": "recording",
               "duration": 0, "summary": None, "summary_md": ""}
        return self.store.put("meetings", rec)

    def update(self, mid: str, patch: dict) -> dict:
        def apply(r):
            for k in EDITABLE:
                if k in patch:
                    v = patch[k]
                    r[k] = float(v or 0) if k == "duration" else str(v if v is not None else "")[:200_000]
        return self.store.update("meetings", mid, apply)

    def add_segments(self, mid: str, segments: list) -> dict:
        clean = []
        for s in segments[:500]:
            if not isinstance(s, dict):
                continue
            try:
                clean.append({"start": round(float(s.get("start") or 0), 2), "end": round(float(s.get("end") or 0), 2),
                              "text": str(s.get("text") or "").strip()[:20000]})
            except (TypeError, ValueError):
                continue

        def apply(r):
            segs = r.setdefault("segments", [])
            for c in clean:  # replace a segment that was re-transcribed, else append
                for i, old in enumerate(segs):
                    if abs(old.get("start", -1) - c["start"]) < 0.05:
                        segs[i] = c
                        break
                else:
                    segs.append(c)
            segs.sort(key=lambda x: x["start"])
            r["duration"] = max(r.get("duration") or 0, max((c["end"] for c in clean), default=0))
        rec = self.store.update("meetings", mid, apply)
        return self.summary(rec)

    def delete(self, mid: str):
        job = self.jobs.running("meeting-summary", meeting=mid)
        if job:
            self.jobs.cancel(job.id)
        self.store.delete("meetings", mid)

    # -- summary ------------------------------------------------------------------------------
    def start_summary(self, mid: str, model: str):
        rec = self.get(mid)
        if not transcript_text(rec).strip():
            raise BadRequest("There is no transcript to summarize yet.")
        if rec.get("job"):
            raise BadRequest("A summary is already being written.")
        return self.jobs.start("meeting-summary", f"Summarizing {rec.get('title')}", lambda job: self._summary_job(job, mid, model or "default"),
                               {"meeting": mid})

    def _summary_job(self, job, mid, model):
        info = self.devconn.resolve()
        npu.ensure_ready(model, policy="fits", job=job, info=info)
        rec = self.get(mid)
        text = transcript_text(rec)
        notes = (rec.get("notes") or "").strip()
        parts = self._split(text)
        if len(parts) > 1:  # long meeting: notes per part first, then one summary over the notes
            partial = []
            for i, part in enumerate(parts, 1):
                job.check()
                job.update(message=f"Reading part {i} of {len(parts)}…", progress=(i - 1) / (len(parts) + 1))
                out = device.chat(info, model, [
                    {"role": "system", "content": SYSTEM},
                    {"role": "user", "content": f"This is part {i} of {len(parts)} of a meeting transcript. Write dense bullet-point notes "
                                                f"of everything important in it: topics, facts, numbers, decisions, tasks with owners and dates, "
                                                f"open questions. Keep the timestamps of key moments.\n\n{part}"}],
                    thinking=False, max_tokens=1500, temperature=0.2, timeout=900)
                partial.append(f"Notes for part {i} ({part.splitlines()[0][:9] if part else ''}…):\n{out['content']}")
            material = "\n\n".join(partial)
            what = "notes taken from a long meeting, part by part"
        else:
            material = text
            what = "a meeting transcript with timestamps"
        job.check()
        job.update(message="Writing the summary…", progress=len(parts) / (len(parts) + 1))
        user = f"Here is {what}:\n\n{material}"
        if notes:
            user += f"\n\nThe note-taker also wrote these notes during the meeting (trust them over the transcript):\n{notes}"
        user += "\n\n" + FORMAT
        msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]
        out = device.chat(info, model, msgs, thinking=False, max_tokens=2500, temperature=0.2, timeout=1200)
        data = _json_from(out["content"])
        if data is None:  # one repair attempt
            msgs += [{"role": "assistant", "content": out["content"][:8000]},
                     {"role": "user", "content": "That wasn't valid JSON. Reply again with only the JSON object."}]
            out = device.chat(info, model, msgs, thinking=False, max_tokens=2500, temperature=0, timeout=900)
            data = _json_from(out["content"])
        if data is None:
            md, data = out["content"].strip(), {}
        else:
            md = summary_markdown(data)
        if not md:
            raise DeviceError("The model returned an empty summary")
        auto_title = re.match(r"^Meeting \d{4}-\d{2}-\d{2} \d{2}:\d{2}$", rec.get("title") or "")

        def apply(r):
            r["summary"] = data
            r["summary_md"] = md
            r["summary_model"] = model
            r["status"] = "done"
            if auto_title and str(data.get("title") or "").strip():
                r["title"] = str(data["title"]).strip()[:120]
        self.store.update("meetings", mid, apply)
        job.update(message="Summary ready", progress=1)
        try:  # then the action items, decisions and open questions, if a decision model can answer
            self._highlights(job, mid)
        except Exception as e:  # noqa: BLE001 - the summary is done; this part is extra
            job.update(log=f"Action items skipped: {e}")
        job.update(message="Summary ready", progress=1)
        return {"ok": True}

    def start_highlights(self, mid: str):
        rec = self.get(mid)
        if not (rec.get("segments") or []):
            raise BadRequest("There is no transcript yet.")
        if rec.get("job"):
            raise BadRequest("Something is already running for this meeting.")
        return self.jobs.start("meeting-highlights", f"Finding action items in {rec.get('title')}",
                               lambda job: self._highlights(job, mid, explicit=True), {"meeting": mid})

    def _highlights(self, job, mid, explicit=False):
        """A decision model reads the transcript sentence by sentence (60 per request, with a little context before):
        action items, decisions and open questions, kept when it's at least 50 % sure."""
        rec = self.store.get("meetings", mid) or {}
        sents = sentences(rec.get("segments") or [])
        found, model, batch = [], None, 60
        for b in range(0, len(sents), batch):
            job.check()
            part = sents[b:b + batch]
            job.update(message=f"Finding action items… {min(b + batch, len(sents))} of {len(sents)} sentences", progress=b / max(1, len(sents)))
            state = (f"Meeting transcript ({rec.get('title') or 'meeting'}):\n"
                     + "".join(f"(before) {s['text']}\n" for s in sents[max(0, b - 4):b])
                     + "".join(f"[{i}] {fmt_ts(s['start'])} {s['text']}\n" for i, s in enumerate(part, b + 1)))
            questions = {f"s{i}": {"type": "choice", "instructions": f"What is sentence [{i}]?", "criteria": HIGHLIGHT_KINDS}
                         for i in range(b + 1, b + 1 + len(part))}
            try:
                out = decide.decide(self.devconn, None, "meeting_highlights", state, questions, timeout=600)
            except decide.Unavailable as e:
                if explicit:
                    raise DeviceError(str(e))
                job.update(log=f"Action items skipped: {e}")
                return {"highlights": None}
            model = out["model"]
            for i, s in enumerate(part, b + 1):
                a = out["answers"].get(f"s{i}") or {}
                kind = a.get("best")
                p = (a.get("p") or {}).get(kind)
                if kind in ("action", "decision", "question") and p is not None and p >= 0.5:
                    twin = next((x for x in found if x["kind"] == kind and _same(x["text"]) == _same(s["text"])), None)
                    if twin:  # said again later: listed once, at the first time
                        twin["p"] = max(twin["p"], round(p, 3))
                    else:
                        found.append({"start": s["start"], "text": s["text"][:500], "kind": kind, "p": round(p, 3)})

        def apply(r):
            r["highlights"] = found
            r["highlights_model"] = model
        self.store.update("meetings", mid, apply)
        job.update(message=f"Found {len(found)} action item(s), decision(s) and question(s)", progress=1)
        return {"highlights": len(found)}

    @staticmethod
    def _split(text: str) -> list:
        if estimate_tokens(text) <= CHUNK_TOKENS * 1.6:
            return [text]
        parts, cur, cur_t = [], [], 0
        for line in text.split("\n"):
            t = estimate_tokens(line) + 1
            if cur and cur_t + t > CHUNK_TOKENS:
                parts.append("\n".join(cur))
                cur, cur_t = [], 0
            cur.append(line)
            cur_t += t
        if cur:
            parts.append("\n".join(cur))
        return parts

    # -- export ------------------------------------------------------------------------------------
    def markdown(self, mid: str) -> tuple:
        rec = self.get(mid)
        when = time.strftime("%Y-%m-%d %H:%M", time.localtime(rec.get("created") or time.time()))
        out = [f"# {rec.get('title') or 'Meeting'}", "", f"- Date: {when}", f"- Length: {fmt_ts(rec.get('duration') or 0)}"]
        if rec.get("file_name"):
            out.append(f"- Recording: {rec['file_name']}")
        out.append("")
        if rec.get("summary_md"):
            out += [rec["summary_md"].strip(), ""]
        if (rec.get("notes") or "").strip():
            out += ["## Notes", "", rec["notes"].strip(), ""]
        out += ["## Transcript", "", transcript_text(rec) or "(empty)", ""]
        name = (safe_name(re.sub(r"[\\/:*?\"<>|]+", " ", rec.get("title") or "meeting")).strip() or "meeting")[:100] + ".md"
        return name, "\n".join(out)

    def to_vault(self, mid: str) -> dict:
        name, md = self.markdown(mid)
        out = device.vault_upload(self.devconn.resolve(), self.rt.work / "uploads", name, md.encode("utf-8"))
        self.store.update("meetings", mid, lambda r: r.update(vault_source_id=out.get("source_id")))
        return out

    def to_project(self, mid: str, pid: str) -> dict:
        name, md = self.markdown(mid)
        doc = self.projects.add_doc(pid, {"kind": "note", "title": name[:-3], "text": md})
        self.store.update("meetings", mid, lambda r: r.setdefault("projects", []).append(pid))
        return doc
