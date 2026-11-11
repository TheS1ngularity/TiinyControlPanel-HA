"""Routines: things the panel does by itself on a schedule. An agent prompt in its own chat (a morning briefing), or a
code review of a folder (a weekly review that says what's new).

A routine is a record in the "routines" collection:
  {id, name, enabled, schedule, action, next_run, last_run, runs (newest first, at most MAX_RUNS)}
  schedule  {"kind": "daily", "time": "08:00"} · {"kind": "weekdays", "time": "08:00"} ·
            {"kind": "weekly", "days": [0, 2, 4], "time": "08:00"} (0 is Monday) · {"kind": "hours", "every": 4}
  action    {"kind": "agent", "prompt", "model", "tools" (the ones it may use by itself), "project_id", "use_vault",
             "chat_id" (its chat, made on the first run)}
            {"kind": "review", "folder", "model", "focus", "thinking", "review_id" (made on the first run),
             "seen" (the findings of the last run, to tell what's new)}
Times are this computer's local time.

The runner looks every CHECK_EVERY seconds and starts one routine at a time; a run that waits for your approval doesn't
count. When the Tiiny doesn't answer, the run waits and tries again every RETRY_OFFLINE seconds. Runs missed while the
panel was off run once when it starts if they're less than MISSED_WINDOW old; older ones are skipped.

A routine never unloads your models, and what it loads it gives back (common.Borrowed): unloaded again
agenttools.UNATTENDED_UNLOAD_AFTER seconds after its last use, unless something else uses it. An agent prompt runs
unattended (turns.py): only the tools the routine allows run by themselves, any other is refused for that run, and
commands and file changes wait for your approval in the routine's chat.
"""

from __future__ import annotations

import datetime
import hashlib
import re
import threading
import time
import traceback
from pathlib import Path

from . import agenttools as at, decide, device, npu
from .common import BORROWED, BadRequest, DeviceError, new_id, valid_id
from .files import read_text
from .turns import split_thinking

CHECK_EVERY = 30          # seconds between looks at what's due
RETRY_OFFLINE = 600       # seconds between tries while the Tiiny doesn't answer
MISSED_WINDOW = 12 * 3600  # a run missed by more than this is skipped instead of run late
MAX_RUNS = 50
KINDS = ("daily", "weekdays", "weekly", "hours")
DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
COMPUTER_RISKS = ("command", "file", "open", "computer")


# -- schedules ----------------------------------------------------------------------------------------------------------
def parse_time(value) -> tuple:
    m = re.fullmatch(r"([01]?\d|2[0-3]):([0-5]\d)", str(value or "").strip())
    if not m:
        raise BadRequest("Give the time as hours and minutes, for example 08:00.")
    return int(m.group(1)), int(m.group(2))


def next_after(schedule: dict, after: float) -> float:
    """The first time the schedule fires after `after` (local time)."""
    kind = schedule.get("kind")
    if kind == "hours":
        return after + int(schedule.get("every") or 1) * 3600
    hh, mm = parse_time(schedule.get("time"))
    days = set(range(7)) if kind == "daily" else set(range(5)) if kind == "weekdays" else {int(d) for d in schedule.get("days") or []}
    t = datetime.datetime.fromtimestamp(after)
    c = t.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if c <= t:
        c += datetime.timedelta(days=1)
    for _ in range(8):
        if c.weekday() in days:
            return c.timestamp()
        c += datetime.timedelta(days=1)
    return after + 86400


def describe(schedule: dict) -> str:
    """The schedule in words: "every day at 08:00", "on weekdays at 08:00", "on Monday and Friday at 18:30", "every 4 hours"."""
    kind = schedule.get("kind")
    if kind == "hours":
        n = int(schedule.get("every") or 1)
        return "every hour" if n == 1 else f"every {n} hours"
    at_ = f"at {schedule.get('time')}"
    if kind == "daily":
        return f"every day {at_}"
    if kind == "weekdays":
        return f"on weekdays {at_}"
    names = [DAY_NAMES[d] for d in sorted({int(d) for d in schedule.get("days") or []}) if 0 <= d < 7]
    return f"on {', '.join(names[:-1]) + ' and ' + names[-1] if len(names) > 1 else (names[0] if names else 'no day')} {at_}"


def clean_schedule(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    kind = raw.get("kind")
    if kind not in KINDS:
        raise BadRequest("Choose when it runs: every day, on weekdays, on some days of the week, or every few hours.")
    if kind == "hours":
        try:
            every = int(raw.get("every") or 0)
        except (TypeError, ValueError):
            every = 0
        if not 1 <= every <= 168:
            raise BadRequest("“Every few hours” takes a number of hours from 1 to 168.")
        return {"kind": kind, "every": every}
    hh, mm = parse_time(raw.get("time"))
    out = {"kind": kind, "time": f"{hh:02d}:{mm:02d}"}
    if kind == "weekly":
        try:
            days = sorted({int(d) for d in raw.get("days") or []})
        except (TypeError, ValueError):
            days = []
        if not days or any(not 0 <= d <= 6 for d in days):
            raise BadRequest("Pick at least one day of the week.")
        out["days"] = days
    return out


def _h(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


def finding_sig(root: Path, f: dict, cache: dict = None) -> dict:
    """A finding as a routine recognises it in a later run: its file, the lines of code it points at and its title. A model
    doesn't point at exactly the same lines every time, so each line counts on its own (see same_finding)."""
    lines = []
    try:
        if cache is not None and f["path"] in cache:
            text = cache[f["path"]]
        else:
            text = read_text(root / f["path"], 2_000_000).split("\n")
            if cache is not None:
                cache[f["path"]] = text
        lo, hi = max(1, int(f.get("line_start") or 1)), int(f.get("line_end") or f.get("line_start") or 1)
        lines = [re.sub(r"\s+", " ", x).strip() for x in text[lo - 1:min(hi, lo + 5)]]
    except (OSError, ValueError, KeyError):
        pass
    return {"path": f.get("path"), "lines": sorted({_h(x) for x in lines if len(x) >= 8}),
            "title": _h(re.sub(r"\W+", " ", str(f.get("title") or "").lower()).strip())}


def same_finding(a: dict, b: dict) -> bool:
    """The same problem: the same file, and the same title or a line of code in common."""
    return a.get("path") == b.get("path") and (a.get("title") == b.get("title") or bool(set(a.get("lines") or []) & set(b.get("lines") or [])))


# -- the routines -------------------------------------------------------------------------------------------------------
class Routines:
    def __init__(self, store, turns, reviews, jobs, devconn, settings):
        self.store, self.turns, self.reviews, self.jobs, self.devconn, self.settings = store, turns, reviews, jobs, devconn, settings
        self.lock = threading.RLock()
        self.wake = threading.Event()
        self.active = {}      # routine id -> what its running run needs to finish (job, run id, borrowed models)
        self.thread = None
        self.clock = time.time

    # -- records ------------------------------------------------------------------------------------------------------
    def _get(self, rid: str) -> dict:
        rec = self.store.get("routines", rid) if valid_id(rid) else None
        if not rec:
            raise BadRequest("That routine no longer exists.")
        return rec

    def public(self, rec: dict) -> dict:
        out = dict(rec)
        out["when"] = describe(rec.get("schedule") or {})
        a = self.active.get(rec["id"])
        if a:   # a run going on now: is it waiting for you?
            turn = self.turns.get(a["job"].id) if a["kind"] == "agent" else None
            out["running"] = {"job": a["job"].id, "waiting": bool(turn and turn.waiting), "message": a["job"].message}
        return out

    def list(self) -> list:
        recs = self.store.list("routines")
        recs.sort(key=lambda r: (r.get("created") or 0))
        return [self.public(r) for r in recs]

    def get(self, rid: str) -> dict:
        return self.public(self._get(rid))

    def _clean(self, spec: dict, old: dict = None, remote: bool = False) -> dict:
        """A routine from the page, checked. A phone may not set up anything on this computer: code reviews of a folder,
        and tools that look at or change the computer's files."""
        old = old or {}
        name = str(spec.get("name", old.get("name")) or "").strip()[:80]
        if not name:
            raise BadRequest("Give the routine a name.")
        rec = {"name": name, "enabled": bool(spec.get("enabled", old.get("enabled", True))),
               "schedule": clean_schedule(spec.get("schedule", old.get("schedule")))}
        raw = spec.get("action") if isinstance(spec.get("action"), dict) else None
        act_old = old.get("action") or {}
        if raw is None:
            rec["action"] = act_old
            return rec
        kind = raw.get("kind", act_old.get("kind"))
        model = str(raw.get("model") or act_old.get("model") or "").strip()
        if not model:
            raise BadRequest("Choose the model it runs on.")
        if kind == "agent":
            prompt = str(raw.get("prompt", act_old.get("prompt")) or "").strip()[:4000]
            if not prompt:
                raise BadRequest("Write what the routine should ask.")
            tools = []
            for t in raw.get("tools", act_old.get("tools")) or []:
                tool = at.BY_NAME.get(str(t))
                if not tool or tool.always_ask or tool.name in tools:
                    continue   # unknown, or one that asks every time anyway
                if remote and tool.risk in COMPUTER_RISKS and tool.name not in (act_old.get("tools") or []):
                    raise PermissionError("Tools that work on this computer's files can only be allowed on the computer running the panel.")
                tools.append(tool.name)
            pid = raw.get("project_id", act_old.get("project_id"))
            rec["action"] = {"kind": "agent", "prompt": prompt, "model": model, "tools": tools,
                             "project_id": pid if valid_id(pid) else None, "use_vault": bool(raw.get("use_vault", act_old.get("use_vault")))}
            for k in ("chat_id",):
                if act_old.get(k):
                    rec["action"][k] = act_old[k]
        elif kind == "review":
            if remote:
                raise PermissionError("A code review of a folder can only be set up on the computer running the panel.")
            folder = str(raw.get("folder", act_old.get("folder")) or "").strip()
            path = Path(folder).expanduser()
            if not folder or not path.is_absolute() or not path.is_dir():
                raise BadRequest("Choose a folder on this computer to review.")
            focus = raw.get("focus", act_old.get("focus"))
            rec["action"] = {"kind": "review", "folder": str(path.resolve()), "model": model,
                             "focus": focus if focus in ("security", "bugs", "all") else "security",
                             "thinking": bool(raw.get("thinking", act_old.get("thinking")))}
            if act_old.get("folder") == rec["action"]["folder"]:   # the same folder: keep its review and what it saw
                for k in ("review_id", "seen"):
                    if act_old.get(k) is not None:
                        rec["action"][k] = act_old[k]
        else:
            raise BadRequest("A routine asks the agent something, or reviews a folder's code.")
        return rec

    def create(self, spec: dict, remote: bool = False) -> dict:
        rec = self._clean(spec, None, remote)
        rec.update(runs=[], last_run=None, next_run=next_after(rec["schedule"], self.clock()) if rec["enabled"] else None)
        out = self.store.put("routines", rec)
        self.wake.set()
        return self.public(out)

    def update(self, rid: str, patch: dict, remote: bool = False) -> dict:
        with self.lock:
            old = self._get(rid)
            if remote and (old.get("action") or {}).get("kind") == "review" and set(patch) - {"enabled"}:
                raise PermissionError("A code review of a folder can only be changed on the computer running the panel.")
            if set(patch) == {"enabled"}:   # switching on or off works from anywhere
                new = {"name": old["name"], "enabled": bool(patch["enabled"]), "schedule": old["schedule"], "action": old.get("action") or {}}
            else:
                new = self._clean(patch, old, remote)

            def apply(r):
                timing = new["schedule"] != r.get("schedule") or (new["enabled"] and not r.get("enabled"))
                r.update(new)
                if not r["enabled"]:
                    r["next_run"] = None
                    r.pop("postponed", None)
                elif timing or not r.get("next_run"):
                    r["next_run"] = next_after(r["schedule"], self.clock())
            out = self.store.update("routines", rid, apply)
        self.wake.set()
        return self.public(out)

    def delete(self, rid: str) -> bool:
        self._get(rid)
        return self.store.delete("routines", rid)

    def run_now(self, rid: str) -> dict:
        rec = self._get(rid)
        if rid in self.active:
            raise BadRequest("It's running already.")
        out = self.store.update("routines", rid, lambda r: r.update(next_run=self.clock(), due_now=True))
        self.wake.set()
        return self.public(out)

    # -- the runner ----------------------------------------------------------------------------------------------------
    def start(self):
        if self.thread is None:
            self.thread = threading.Thread(target=self._loop, daemon=True, name="routines")
            self.thread.start()

    def _loop(self):
        try:
            self.catch_up()
        except Exception:  # noqa: BLE001 - the runner keeps going
            traceback.print_exc()
        while True:
            try:
                self.tick()
            except Exception:  # noqa: BLE001
                traceback.print_exc()
            self.wake.wait(CHECK_EVERY)
            self.wake.clear()

    def catch_up(self):
        """When the panel starts: runs it was in the middle of say so, and runs missed long ago are skipped."""
        now = self.clock()
        for r in self.store.list("routines"):
            def apply(rec):
                for run in rec.get("runs") or []:
                    if run.get("status") in ("running", "waiting"):
                        run.update(status="interrupted", summary="The panel stopped while it ran.")
                if rec.get("enabled") and rec.get("next_run") and rec["next_run"] < now - MISSED_WINDOW:
                    rec["runs"] = ([{"id": new_id("x"), "at": rec["next_run"], "status": "skipped",
                                     "summary": "Missed: the panel wasn't running then."}] + (rec.get("runs") or []))[:MAX_RUNS]
                    rec["next_run"] = next_after(rec["schedule"], now)
            self.store.update("routines", r["id"], apply)

    def _device_up(self) -> bool:
        try:
            status, _, _ = device.call(self.devconn.resolve(), "core", "GET", "/api/v1/sys/status", timeout=8)
        except DeviceError:
            return False
        return 200 <= status < 300

    def _busy(self) -> bool:
        """Is a routine running now (one that isn't just waiting for your approval)?"""
        for a in self.active.values():
            turn = self.turns.get(a["job"].id) if a["kind"] == "agent" else None
            if not a["job"].finished and not (turn and turn.waiting):
                return True
        return False

    def tick(self):
        with self.lock:
            self._finish_runs()
            if self._busy():
                return
            now = self.clock()
            due = [r for r in self.store.list("routines") if r["id"] not in self.active and r.get("next_run") and r["next_run"] <= now
                   and (r.get("enabled") or r.get("due_now"))]   # Run now works on one that's switched off, once
            if not due:
                return
            r = min(due, key=lambda x: x["next_run"])
            if not self._device_up():
                self._postpone(r, now)
                return
            self._run(r)

    def _postpone(self, r: dict, now: float):
        def apply(rec):
            since = rec.get("postponed_since") or now
            if now - since > MISSED_WINDOW:   # it never came back: skip this one
                rec["runs"] = ([{"id": new_id("x"), "at": now, "status": "skipped",
                                 "summary": "Skipped: your Tiiny wasn't answering."}] + (rec.get("runs") or []))[:MAX_RUNS]
                rec["next_run"] = next_after(rec["schedule"], now)
                rec.pop("postponed_since", None)
                rec.pop("postponed", None)
                return
            rec["postponed_since"] = since
            rec["postponed"] = "Your Tiiny isn't answering, so it waits and tries again every 10 minutes."
            rec["next_run"] = now + RETRY_OFFLINE
        self.store.update("routines", r["id"], apply)

    def _run(self, r: dict):
        now = self.clock()
        run = {"id": new_id("x"), "at": now, "status": "running"}
        action_update, active = {}, None
        try:
            if (r.get("action") or {}).get("kind") == "agent":
                active, extra, action_update = self._start_agent(r)
            else:
                active, extra, action_update = self._start_review(r)
            run.update(extra, job=active["job"].id)
            active["run"] = run["id"]
            self.active[r["id"]] = active
            threading.Thread(target=self._wake_when_done, args=(active["job"],), daemon=True).start()
        except (BadRequest, DeviceError) as e:
            run.update(status="failed", summary=str(e))

        def apply(rec):
            rec["runs"] = ([run] + (rec.get("runs") or []))[:MAX_RUNS]
            rec["last_run"] = now
            rec["action"] = dict(rec.get("action") or {}, **action_update)
            rec["next_run"] = next_after(rec["schedule"], now) if rec.get("enabled") else None
            for k in ("postponed_since", "postponed", "due_now"):
                rec.pop(k, None)
        self.store.update("routines", r["id"], apply)

    def _wake_when_done(self, job):
        """The result is written as soon as the run ends, not at the next look."""
        version = -1
        while not job.finished:
            version = self.jobs.wait(job, version, 30)
        self.wake.set()

    def _start_agent(self, r: dict):
        act = r["action"]
        chat = self.store.get("chats", act["chat_id"]) if valid_id(act.get("chat_id")) else None
        if not chat:
            chat = {"id": new_id("c"), "title": r["name"], "system": "", "messages": [], "thinking": None, "depth": None,
                    "agentAllow": {}, "agentAuto": False, "useProfile": False, "knowledge_id": None, "pinned_count": 0}
        chat.update(model=act["model"], agent=True, useVault=bool(act.get("use_vault")), project_id=act.get("project_id"), routine=r["id"])
        chat.setdefault("messages", []).append({"role": "user", "content": act["prompt"]})
        chat["rev"] = (chat.get("rev") or 0) + 1
        self.store.put("chats", chat, chat["id"])
        when = time.strftime("%A %d %B %Y, %H:%M", time.localtime(self.clock()))
        instructions = (f"This message comes from the routine “{r['name']}”, which runs {describe(r['schedule'])}; it was sent on {when}. "
                        "The user may not be watching right now: tools this routine may not use are refused, and commands and file changes "
                        "wait until the user approves them. Write the answer so it makes sense when read later.")
        job = self.turns.start(chat["id"], unattended=True, allowed=set(act.get("tools") or []), instructions=instructions,
                               why=f"Routine: {r['name']}", routine=r["id"])
        return {"job": job, "kind": "agent"}, {"chat": chat["id"], "link": f"#/chat/{chat['id']}"}, {"chat_id": chat["id"]}

    def _start_review(self, r: dict):
        act = r["action"]
        rev = None
        if valid_id(act.get("review_id")) and self.store.get("reviews", act["review_id"]):
            rev = self.reviews.rescan(act["review_id"])
        if rev is None:
            rev = self.reviews.create({"kind": "folder", "path": act["folder"], "name": r["name"]})
        info = self.devconn.resolve()
        loaded = set(device.running_ids(info))
        session = f"routine-{r['id']}-{new_id()}"
        model = act["model"]
        borrowed = []
        if model != "default" and BORROWED.borrow(model, session, loaded=model in loaded, why=f"Routine: {r['name']}", after=at.UNATTENDED_UNLOAD_AFTER):
            borrowed.append(model)
        job = self.reviews.start(rev["id"], {"model": model, "focus": act.get("focus"), "thinking": act.get("thinking")},
                                 title=f"Routine: {r['name']}", meta={"routine": r["id"]})
        active = {"job": job, "kind": "review", "session": session, "borrowed": borrowed, "loaded_before": loaded, "review": rev["id"],
                  "name": r["name"]}
        return active, {"review": rev["id"], "link": f"#/review/{rev['id']}"}, {"review_id": rev["id"]}

    def _finish_runs(self):
        """Runs whose job ended get their result."""
        for rid, a in list(self.active.items()):
            job = a["job"]
            if not job.finished:
                continue
            del self.active[rid]
            try:
                result, seen = self._result(a, job)
            except Exception as e:  # noqa: BLE001 - the run still ends
                traceback.print_exc()
                result, seen = {"status": "failed", "summary": f"Couldn't read how it went: {e}"}, None
            if a["kind"] == "review":
                self._give_back(a)

            def apply(rec):
                if seen is not None:   # a review: what's new since the last run
                    before = [x for x in (rec.get("action") or {}).get("seen") or [] if isinstance(x, dict)]
                    new = len([x for x in seen if not any(same_finding(x, y) for y in before)])
                    result["new"] = new
                    result["summary"] = (f"{new} new finding{'' if new == 1 else 's'}" if new else "No new findings") + \
                        (f" ({len(seen)} in all)" if len(seen) != new else "")
                    rec["action"] = dict(rec.get("action") or {}, seen=seen)
                for run in rec.get("runs") or []:
                    if run.get("id") == a["run"]:
                        run.update(result, ended=self.clock())
            try:
                self.store.update("routines", rid, apply)
            except BadRequest:
                pass   # deleted while it ran

    def _give_back(self, a: dict):
        """A review routine's models: the review model, and a decision model it loaded to check the findings."""
        for mid in a["borrowed"]:
            BORROWED.give_back(mid, a["session"], at.UNATTENDED_UNLOAD_AFTER)
        try:
            info = self.devconn.resolve()
            now_loaded = set(device.running_ids(info))
            deciders = {m["id"] for m in npu.models(info) if decide.is_decider(m)}
        except DeviceError:
            return
        for mid in (now_loaded - a["loaded_before"]) & deciders:
            if BORROWED.borrow(mid, a["session"], loaded=False, why=f"Routine: {a['name']}", after=at.UNATTENDED_UNLOAD_AFTER):
                BORROWED.give_back(mid, a["session"], at.UNATTENDED_UNLOAD_AFTER)

    def _result(self, a: dict, job) -> tuple:
        if a["kind"] == "agent":
            rec = self.store.get("chats", (job.meta or {}).get("chat") or "") or {}
            msg = next((m for m in reversed(rec.get("messages") or []) if m.get("role") == "assistant"), {})
            if msg.get("error"):
                return {"status": "failed", "summary": msg["error"][:300]}, None
            if job.status == "cancelled" or (msg.get("meta") or {}).get("stopped"):
                return {"status": "stopped", "summary": "Stopped before it finished."}, None
            answer = re.sub(r"\s+", " ", split_thinking(msg)[1]).strip()
            return {"status": "done", "summary": (answer[:157] + "…") if len(answer) > 160 else answer or "Done."}, None
        if job.status != "done":
            return {"status": "stopped" if job.status == "cancelled" else "failed", "summary": job.error or "The review stopped."}, None
        rev = self.store.get("reviews", a["review"]) or {}
        root, cache = Path(rev.get("root") or "."), {}
        sigs = [finding_sig(root, f, cache) for f in rev.get("findings") or [] if f.get("state") != "false_positive"]
        return {"status": "done", "findings": len(sigs)}, sigs
