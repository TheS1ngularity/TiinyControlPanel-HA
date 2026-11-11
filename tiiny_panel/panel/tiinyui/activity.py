"""What the Tiiny is doing right now: the dashboard's "Right now" card and the agent's device check.

The device lists the work running on its models in /api/v1/npu/status. "occupants" holds, for each app, the models it
uses and their active tasks, each with the kind of work ("modality") and when it started. Programs that don't name
themselves, this panel included, all show up there as "API". So the panel notes its own requests while they run
(track), with the chat, page or background job they're for. now() pairs those notes with the device's list: the
panel's tasks get their names ("Chat: Trip plans", "Reviewing my-project"), and the rest show the app the device names.
"""

from __future__ import annotations

import itertools
import re
import threading
import time
from contextlib import contextmanager

from . import jobs

# The kinds of work, checked in this order: the device's word for it (its "modality"), and the API paths that do it.
KINDS = (
    ("embed", r"embed", r"/v1/embeddings"),
    ("rerank", r"rerank", r"/v1/rerank"),
    ("decide", r"systemone|classif|decision", r"/v1/systemone"),
    ("transcribe", r"asr|transcri|stt|speech.?to", r"/v1/audio/(transcriptions|translations)"),
    ("speech", r"tts|text.?to.?speech|speech|voice", r"/v1/audio/speech"),
    ("music", r"music|song", r"/v1/(audio/)?music"),
    ("3d", r"3d|mesh", r"/v1/3d/tasks$"),
    ("video", r"video", r"/v1/videos$"),
    ("image", r"image|diffus|t2i|i2i", r"/v1/images/"),
    ("chat", r"chat|complet|text|vision|multimodal|llm|vlm", r"/v1/(chat/)?completions|/v1/responses|/v1/messages"),
)
STUDIO_JOBS = {"music", "model3d", "video"}  # the device works on these after the request has returned
NOT_DEVICE_JOBS = {"command", "update", "backup"}  # jobs that run on this computer, not on the Tiiny
APPS_EVERY = 300                              # seconds between fetches of the device's app list
ROUTE = re.compile(r"[\w\-/?=&.%]{1,200}")

_lock = threading.Lock()
_mine: dict = {}            # the panel's requests to the device that are still running
_ids = itertools.count(1)
_local = threading.local()  # labelled(): what the requests made on this thread are for
_seen: dict = {}            # the device's tasks at the last look, to notice when one ends
_seen_at = [0.0]            # when that was
_last: dict = {}            # the last task seen ending
SEEN_FOR = 30               # a task gone since a look longer ago than this ended at an unknown time: not "last"
_apps = {"names": {}, "at": 0.0}


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None


def route(v) -> str | None:
    """A page of the panel ("chat/c1", "playground?tool=image"), as sent by the page; anything else is dropped."""
    v = str(v or "").strip().lstrip("#/")
    return v if ROUTE.fullmatch(v) else None


def kind_of_modality(modality) -> str | None:
    m = str(modality or "").lower()
    return next((kind for kind, words, _ in KINDS if m and re.search(words, m)), None)


def kind_of_path(path) -> str | None:
    p = str(path or "").split("?")[0]
    return next((kind for kind, _, paths in KINDS if re.match(paths, p)), None)


# -- the panel's own requests ------------------------------------------------------------------------------------------
@contextmanager
def labelled(title=None, href=None, phone=False):
    """Requests to the device made inside this block are for `title`, shown on the page `href`."""
    old = getattr(_local, "label", None)
    _local.label = {"title": title, "href": href, "phone": phone}
    try:
        yield
    finally:
        _local.label = old


@contextmanager
def track(path, model=None, *, title=None, href=None, phone=None):
    """Note a request to the device while it runs, when it's model work (a chat, an image, …; not a status check).
    What it's for comes from the arguments, else from labelled(), else from the job this thread is working for."""
    kind = kind_of_path(path)
    if not kind:
        yield None
        return
    label = getattr(_local, "label", None) or {}
    job = jobs.current()
    entry = {"id": next(_ids), "kind": kind, "model": str(model or ""), "started": time.time(),
             "title": title or label.get("title") or (job.title if job else None),
             "href": href or label.get("href"), "phone": bool(label.get("phone") if phone is None else phone),
             "job": job.id if job else None, "jobkind": job.kind if job else None, "meta": dict(job.meta) if job else None}
    with _lock:
        _mine[entry["id"]] = entry
    try:
        yield entry
    finally:
        with _lock:
            _mine.pop(entry["id"], None)


def busy_models() -> set:
    """The models the panel's own requests are using right now."""
    with _lock:
        return {e["model"] for e in _mine.values() if e["model"]}


def ahead_of(entry) -> list:
    """The panel's other requests on the same model that started before `entry`, oldest first. Your Tiiny answers one
    request at a time per model, in the order they came (measured 2026-11-10; different models work at the same time),
    so these are answered first."""
    if not entry or not entry.get("model"):
        return []
    with _lock:
        return [dict(e) for e in sorted(_mine.values(), key=lambda e: (e["started"], e["id"]))
                if e["id"] != entry["id"] and e["model"] == entry["model"] and (e["started"], e["id"]) < (entry["started"], entry["id"])]


def on_model(model) -> int:
    """How many of the panel's requests are using `model` right now."""
    with _lock:
        return sum(1 for e in _mine.values() if e["model"] == model)


def app_names(fetch, wanted) -> dict:
    """{app id: name} from the device's app list (KiloCode-Tiiny → KiloCode). `fetch()` returns the list; it's only
    called when an app isn't known yet, and at most every few minutes."""
    unknown = [a for a in wanted if a and a != "API" and a not in _apps["names"]]
    if unknown and time.time() - _apps["at"] > APPS_EVERY:
        _apps["at"] = time.time()
        try:
            data = fetch() or {}
        except Exception:  # noqa: BLE001 - names are a nicety; the app id is shown instead
            data = {}
        apps = data.get("app") if isinstance(data, dict) else None
        for a in apps if isinstance(apps, list) else []:
            if isinstance(a, dict) and a.get("app_id"):
                _apps["names"][str(a["app_id"])] = str(a.get("app_name") or a["app_id"])[:60]
    return _apps["names"]


# -- what's running ----------------------------------------------------------------------------------------------------
def device_tasks(npu) -> list:
    """The device's task list, flat: one entry per running task, with requests still waiting counted on it."""
    out = []
    occ = npu.get("occupants") if isinstance(npu, dict) else None
    for app in occ if isinstance(occ, list) else []:
        if not isinstance(app, dict):
            continue
        for m in app.get("activate_model") or []:
            if not isinstance(m, dict):
                continue
            model = str(m.get("model_name") or "")
            active = [x for x in m.get("active_tasks") or [] if isinstance(x, dict)]
            for x in active:
                out.append({"app": str(x.get("app_id") or app.get("app_id") or "API"), "model": model,
                            "kind": kind_of_modality(x.get("modality")), "modality": str(x.get("modality") or "")[:40],
                            "started": _num(x.get("started_at")), "label": str(x.get("display_type") or "")[:60],
                            "waiting": 0})
            extra = int(_num(m.get("active_request_count")) or 0) - len(active)
            if extra > 0 and active:
                out[-1]["waiting"] = extra
            elif extra > 0:  # busy, without the details
                out.append({"app": str(app.get("app_id") or "API"), "model": model, "kind": None, "modality": "",
                            "started": None, "label": "", "waiting": extra - 1})
    return out


def _for_job(e) -> dict:
    """A request made for a job that has ended (cancelled): the device is still finishing it."""
    return {"jobkind": e["jobkind"], "meta": e["meta"], "stopping": True} if e.get("job") else {}


def now(npu, instances, panel_jobs, names, clock=time.time) -> dict:
    """What the device is doing: {"busy", "tasks": [...], "last"}. Each task has a kind of work (chat, image, …, or
    "job" for the panel's background jobs and "load" for a model loading), the model, who asked for it ("app"; "mine"
    when it's this panel, with its "title" and page "href"), how long it has run ("elapsed", seconds), and for jobs
    their progress. "last" says what ran last when nothing runs now."""
    global _seen, _last
    t = clock()
    tasks = device_tasks(npu)
    with _lock:
        mine = sorted((dict(e) for e in _mine.values()), key=lambda e: e["started"])
    # pair the panel's requests with the device's anonymous ("API") tasks: same model and kind, closest start
    free = [d for d in tasks if d["app"] == "API"]
    for e in mine:
        cands = [d for d in free if (not e["model"] or e["model"] == "default" or d["model"] == e["model"])
                 and d["kind"] in (None, e["kind"])]
        if cands:
            d = min(cands, key=lambda d: abs((d["started"] or e["started"]) - e["started"]))
            free.remove(d)
            d["mine"], e["paired"] = e, True
    running = [j for j in panel_jobs if j.get("status") == "running" and j.get("kind") not in NOT_DEVICE_JOBS]
    studio = next((j for j in running if j.get("kind") in STUDIO_JOBS), None)
    rows, by_job = [], {}
    for j in running:
        row = {"key": f"job:{j['id']}", "kind": "job", "job": j["id"], "jobkind": j.get("kind"), "title": j.get("title"),
               "meta": j.get("meta") or {}, "progress": j.get("progress"), "message": j.get("message") or "",
               "elapsed": max(0.0, t - (_num(j.get("created")) or t)), "model": (j.get("meta") or {}).get("model"),
               "mine": True, "working": False}
        rows.append(row)
        by_job[j["id"]] = row
    for d in tasks:
        e = d.get("mine")
        job_id = e["job"] if e else (studio["id"] if studio and d["app"] == "API" and d["kind"] in (None, "music", "3d", "video", "image", "speech") else None)
        if job_id in by_job:  # the device is working for one of the panel's jobs
            by_job[job_id]["model"] = by_job[job_id]["model"] or d["model"]
            by_job[job_id]["working"] = True
            continue
        started = e["started"] if e else d["started"]
        row = {"key": f"dev:{d['app']}:{d['model']}:{d['started']}", "kind": d["kind"] or "other",
               "modality": d["modality"], "model": d["model"], "waiting": d["waiting"],
               "elapsed": max(0.0, t - started) if started and t - started < 7 * 86400 else None}
        if e:
            row.update(mine=True, title=e["title"], href=e["href"], phone=e["phone"], **_for_job(e))
        else:
            label = d["label"] if d["label"] and d["label"] != "API" else None
            row.update(mine=False, app=names.get(d["app"]) or label or (None if d["app"] == "API" else d["app"]))
        rows.append(row)
    for e in mine:  # sent, but not (or not yet) in the device's list
        if not e.get("paired") and e["job"] not in by_job:
            rows.append({"key": f"mine:{e['id']}", "kind": e["kind"], "model": e["model"], "mine": True, "title": e["title"],
                         "href": e["href"], "phone": e["phone"], "elapsed": max(0.0, t - e["started"]), "waiting": 0, **_for_job(e)})
    inst = instances.get("instances") if isinstance(instances, dict) else None
    inst = inst if isinstance(inst, dict) else {}
    for p in inst.get("pending") or []:
        if isinstance(p, dict):
            pct = _num(p.get("progress"))
            started = _num(p.get("created_at"))
            rows.append({"key": f"load:{p.get('model_id') or p.get('fullname')}", "kind": "load",
                         "model": str(p.get("model_id") or p.get("fullname") or ""),
                         "progress": pct / 100 if pct is not None and 0 <= pct < 100 else None,
                         "elapsed": max(0.0, t - started) if started and t - started < 86400 else None, "mine": False})
    # remember the last task that ended, for "Last: …" while nothing runs
    seen = {}
    for r in rows:
        if r["kind"] not in ("load",):
            seen[r["key"]] = r
    for k, r in _seen.items():
        if k not in seen and t - _seen_at[0] <= SEEN_FOR:
            _last = dict(r, ended=t)
    _seen, _seen_at[0] = seen, t
    last = None
    if not rows:
        lit = max(((_num(x.get("last_inference_time")) or 0, x.get("model_id")) for x in inst.get("running") or []
                   if isinstance(x, dict)), key=lambda p: p[0], default=(0, None))
        if _last and _last["ended"] >= lit[0]:
            last = {k: _last.get(k) for k in ("kind", "jobkind", "title", "model", "app", "mine", "modality")}
            last.update(ago=max(0.0, t - _last["ended"]), ended=True)
        elif lit[0] and t - lit[0] < 30 * 86400:
            last = {"kind": None, "model": lit[1], "ago": max(0.0, t - lit[0]), "ended": False}
    return {"busy": bool(rows), "tasks": rows, "last": last}
