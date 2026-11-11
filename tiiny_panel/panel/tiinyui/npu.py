"""The NPU planner: whether a model fits next to the loaded ones, what may be unloaded to make room, and loading it.

Everything that loads a model on the panel's side goes through here: background jobs (studio, reviews, projects,
meetings, decisions), apps that use the Tiiny through the gateway, and MCP tools. The page asks it too
(GET /api/npu/plan) for the suggestion in its "Make room" dialog.

How much NPU memory a model takes (share): the share its store entry lists, else what the panel measured when it
loaded the model (settings: npu_footprints), else an estimate from its size on disk. How much is free: the card's own
numbers from /api/v1/npu/status (it reports while a model is loaded), else the card's size minus the loaded shares.

The device keeps its own count too: the listed shares (npu_usage, a percentage) of the loaded and loading models may add
up to 100% at most. A load that would go over makes the device unload a loaded model by itself, at once, even when the
memory really in use leaves room (measured 2026-11-08: GLM-4.7-Flash 57% + Qwen3-8B 28% loaded, starting KnowLine 17%
unloaded GLM, with 11 of 49 GB still free). So a model fits only when both counts leave room.

The device never loads a model by itself (a request for one that isn't loaded gets 404 "is not loaded"), and it
answers /stop in under a second. Loads and unloads happen one at a time, under one lock, so several apps asking at
once queue up instead of racing each other.

Policies, from careful to helpful:
  loaded     use a model only when it's loaded already
  fits       load it when it fits next to the loaded models; never unload anything
  borrowed   like fits, but may unload idle models that were only loaded for a moment (common.Borrowed, given back and not
             in use), never others: what routines use, so one routine's model doesn't block the next
  make_room  unload idle models to make room: borrowed ones first (they were only loaded for a moment, see
             common.Borrowed), then the least recently used. Never pinned ones, busy ones, the ones a running job uses
             or the ones the caller protects.
"""

from __future__ import annotations

import re
import threading
import time
import urllib.parse
from contextlib import contextmanager

from . import activity, device
from .common import BORROWED, DeviceError, error_message, new_id

CARD_MB = 49024         # the Tiiny's NPU card (LQ50-48GB) when it doesn't report
MARGIN_MB = 512         # left free when the planner decides a model fits
DL_BUSY = re.compile(r"^(downloading|queued|pending|paused|waiting|preparing|converting|importing|verifying|extracting)$", re.I)
NO_ROOM = re.compile(r"memory|insufficient|not enough|capacity|resource|exceed|npu", re.I)
POLICIES = ("loaded", "fits", "borrowed", "make_room")
MODELS_TTL = 30         # seconds the device's model list is reused

_lock = threading.RLock()
_ctx = {"devconn": None, "settings": None, "metrics": None}
_models = {"at": 0.0, "list": []}
_job_models = {}        # "job id model id" -> (job, model id): what running background jobs are using (a chat turn can use several)


class NotReady(DeviceError):
    """The model can't be used now; the message says why in plain words. A DeviceError, so jobs and callers that already
    handle the device's errors show it as it is."""


def setup(devconn, settings, metrics=None):
    _ctx.update(devconn=devconn, settings=settings, metrics=metrics)


def short(mid) -> str:
    return str(mid or "").split("/")[-1]


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f > 0 else None


# -- what the device says ---------------------------------------------------------------------------------------
def models(info=None, fresh=False) -> list:
    """The models on the device (all of them, loaded or not), reused for MODELS_TTL seconds."""
    if fresh or time.time() - _models["at"] > MODELS_TTL or not _models["list"]:
        _models["list"] = device.list_models(info or _ctx["devconn"].resolve())
        _models["at"] = time.time()
    return _models["list"]


def forget_models():
    _models["at"] = 0.0


def state(info) -> dict:
    """Loaded (ready) models, the ones still loading, the busy ones, and the card's memory."""
    ready = set(device.running_ids(info))
    status, rj, _ = device.call(info, "core", "GET", "/api/v1/models/running", timeout=15)
    pending = set((rj or {}).get("pending") or []) if 200 <= status < 300 and isinstance(rj, dict) else set()
    status, nj, _ = device.call(info, "core", "GET", "/api/v1/npu/status", timeout=10)
    nj = nj if 200 <= status < 300 and isinstance(nj, dict) else {}
    busy = set()
    for occ in nj.get("occupants") or []:
        for am in occ.get("activate_model") or []:
            if am.get("active_request_count") or am.get("active_tasks"):
                busy.add(am.get("model_name"))
    d0 = (nj.get("devices") or [None])[0]
    total = used = None
    if isinstance(d0, dict) and _num(d0.get("mem_total_mb")):
        total, used = float(d0["mem_total_mb"]), float(d0.get("mem_used_mb") or 0)
    return {"ready": ready, "pending": pending - ready, "busy": busy, "total_mb": total, "used_mb": used}


# -- shares -----------------------------------------------------------------------------------------------------
def share(m: dict, total_mb: float = CARD_MB) -> dict:
    """{mb, source}: listed (the store's share), measured (by the panel), estimated (size × 1.5) or unknown."""
    pct = _num(m.get("npu_usage"))
    if pct:
        return {"mb": total_mb * pct / 100, "source": "listed"}
    measured = _num(((_ctx["settings"].get("npu_footprints") if _ctx["settings"] else None) or {}).get(m.get("id")))
    size_mb = (_num(m.get("size")) or 0) / 1048576
    if measured:
        return {"mb": max(measured, size_mb * 1.5), "source": "measured"}
    if size_mb:
        return {"mb": size_mb * 1.5, "source": "estimated"}
    return {"mb": 8192.0, "source": "unknown"}


def listed_pct(m: dict) -> float:
    """The share of NPU memory the device lists for a model, in percent (0 when it lists none); see the module notes."""
    return _num(m.get("npu_usage")) or 0.0


def _protected(protect=()) -> dict:
    """Models that are never unloaded to make room, with the reason."""
    out = {}
    for mid in (_ctx["settings"].get("keep_loaded") if _ctx["settings"] else None) or []:
        out[mid] = "pinned"
    for job, mid in list(_job_models.values()):
        if not job.finished:
            out.setdefault(mid, "used by a background job")
    for mid in protect or ():
        if mid:
            out.setdefault(mid, "in use here")
    return out


def _last_used(mid) -> float:
    m = _ctx["metrics"]
    return (m.last_used(mid) if m else None) or 0.0


def plan(model: str, protect=(), info=None, st=None, only_borrowed=False) -> dict:
    """Does `model` fit, and if not, which loaded models could be unloaded to make room (and which can't). With
    only_borrowed, only idle models loaded just for a moment may be unloaded (the "borrowed" policy)."""
    info = info or _ctx["devconn"].resolve()
    st = st or state(info)
    by_id = {m["id"]: m for m in models(info)}
    m = by_id.get(model) or {"id": model}
    total = st["total_mb"] or CARD_MB
    sh = share(m, total)
    loaded = sorted(st["ready"] | st["pending"])
    others = [x for x in loaded if x != model]
    if st["used_mb"] is not None:
        free = total - st["used_mb"] - sum(share(by_id.get(x, {"id": x}), total)["mb"] for x in st["pending"] if x != model)
        confident = sh["source"] in ("listed", "measured")
    else:
        free = total - sum(share(by_id.get(x, {"id": x}), total)["mb"] for x in others)
        confident = sh["source"] in ("listed", "measured") and all(share(by_id.get(x, {"id": x}), total)["source"] in ("listed", "measured") for x in others)
    need = sh["mb"] + MARGIN_MB
    # the device's own count: listed shares of everything loaded or loading, plus this one, at most 100%
    pct_need = listed_pct(m)
    pct_used = sum(listed_pct(by_id.get(x, {"id": x})) for x in others)
    pct_over = bool(pct_need) and pct_used + pct_need > 100
    out = {"model": model, "loaded": model in st["ready"], "need_mb": round(sh["mb"]), "free_mb": round(max(0.0, free)),
           "source": sh["source"], "confident": confident or pct_over, "fits": model in st["ready"] or (need <= free and not pct_over),
           "need_pct": round(pct_need), "loaded_pct": round(pct_used), "unload": [], "blocked_by": [], "loaded_models": others}
    if out["fits"]:
        return out
    keep = _protected(protect)
    busy = st["busy"] | activity.busy_models() | ((_ctx["metrics"].busy if _ctx["metrics"] else set()) or set())
    marks = BORROWED.snapshot()
    lent = set(marks)
    candidates, blocked = [], []
    for x in others:
        why = keep.get(x) or ("busy" if x in busy else "loading" if x in st["pending"] else None)
        if not why and only_borrowed and (x not in marks or marks[x]["users"]):
            why = "yours" if x not in marks else "in use"
        (blocked if why else candidates).append((x, why))
    candidates.sort(key=lambda c: (c[0] not in lent, _last_used(c[0])))   # borrowed first, then the least recently used
    freed = freed_pct = 0.0
    room = lambda: need <= free + freed and not (pct_need and pct_used - freed_pct + pct_need > 100)
    for x, _ in candidates:
        if room():
            break
        out["unload"].append(x)
        freed += share(by_id.get(x, {"id": x}), total)["mb"]
        freed_pct += listed_pct(by_id.get(x, {"id": x}))
    if not room():
        out["unload"] = []
        out["blocked_by"] = [{"model": x, "why": why} for x, why in blocked]
    return out


def describe(p: dict) -> str:
    """Why a model doesn't fit, in plain words."""
    name = short(p["model"])
    gb = lambda mb: f"{mb / 1024:.1f} GB"
    if p.get("need_pct") and p.get("loaded_pct", 0) + p["need_pct"] > 100:
        text = (f"{name} doesn't fit in NPU memory right now: your Tiiny counts it as {p['need_pct']}% and the loaded models "
                f"as {p['loaded_pct']}%, and it keeps that at 100% at most.")
    else:
        text = f"{name} doesn't fit in NPU memory right now: it needs about {gb(p['need_mb'])} and {gb(p['free_mb'])} is free."
    if p.get("blocked_by"):
        text += " " + ", ".join(f"{short(b['model'])} is {b['why']}" for b in p["blocked_by"]) + "."
    elif p.get("loaded_models"):
        text += " Loaded: " + ", ".join(short(x) for x in p["loaded_models"]) + "."
    return text


# -- loading ----------------------------------------------------------------------------------------------------
def _stop(info, mid):
    device.call(info, "core", "POST", f"/api/v1/models/{urllib.parse.quote(mid, safe='/')}/stop", timeout=60)
    deadline = time.time() + 20
    while time.time() < deadline and mid in set(device.running_ids(info)):
        time.sleep(0.5)


def unload(model: str, info=None) -> bool:
    """Unload a model now, under the planner's lock (so it can't race a load). True when it's gone."""
    info = info or _ctx["devconn"].resolve()
    with _lock:
        try:
            _stop(info, model)
            gone = model not in set(device.running_ids(info))
        except DeviceError:
            return False
        forget_models()
    return gone


def _wait_ready(info, model, meta, job=None) -> None:
    deadline = time.time() + max(240.0, (_num(meta.get("load_time")) or 30) * 10)
    q = urllib.parse.quote(model, safe="/")
    while time.time() < deadline:
        if job:
            job.check()
        time.sleep(1.5)
        if model in set(device.running_ids(info)):
            return
        status, data, _ = device.call(info, "core", "GET", f"/api/v1/models/{q}/get_progress", timeout=20)
        st = str((data or {}).get("status", "")) if isinstance(data, dict) else ""
        if re.search(r"fail|error", st, re.I):
            raise NotReady(f"The device couldn't load {short(model)}: {(data or {}).get('message') or (data or {}).get('error') or st}")
        if job and isinstance(data, dict) and isinstance(data.get("progress"), (int, float)) and re.search(r"load|start|init|warm|pending", st, re.I):
            job.update(message=f"Loading {short(model)}… {int(data['progress'])}%")
    raise NotReady(f"{short(model)} is taking longer than expected to load. It may still finish; check the Dashboard.")


def _record_footprint(model, meta, mb):
    s = _ctx["settings"]
    if not s or _num(meta.get("npu_usage")) or not mb or mb <= 256:
        return
    cur = s.get("npu_footprints") or {}
    if abs((_num(cur.get(model)) or 0) - mb) < 256:
        return
    s.update({"npu_footprints": dict(cur, **{model: int(mb)})})


def ensure_ready(model: str, *, policy: str = "fits", protect=(), requester: str = "", job=None, info=None) -> dict:
    """Make sure `model` is loaded, following `policy`. Returns {model, loaded_now, unloaded}; raises NotReady."""
    if policy not in POLICIES:
        raise ValueError(policy)
    if not model or model == "default":
        return {"model": model, "loaded_now": False, "unloaded": []}
    info = info or _ctx["devconn"].resolve()
    if job is not None:
        _job_models[f"{job.id} {model}"] = (job, model)
        for key in [k for k, (j, _) in list(_job_models.items()) if j.finished]:
            _job_models.pop(key, None)
        if not (getattr(job, "meta", None) or {}).get("routine"):   # a routine's job gives back what it loaded (routines.py)
            BORROWED.keep(model)   # a background job relies on it: it isn't unloaded when 🎤 or 🔊 are done with it
    try:
        if model in set(device.running_ids(info)):   # loaded: no need to wait for another app's load
            return {"model": model, "loaded_now": False, "unloaded": []}
    except DeviceError as e:
        raise NotReady(str(e))
    with _lock:
        try:
            st = state(info)
            if model in st["ready"]:
                return {"model": model, "loaded_now": False, "unloaded": []}
            meta = next((m for m in models(info) if m["id"] == model), None) or next((m for m in models(info, fresh=True) if m["id"] == model), None)
            if not meta:
                raise NotReady(f"{short(model)} isn't on your Tiiny. Get it from the model store first.")
            if DL_BUSY.match(str(meta.get("status") or "")):
                raise NotReady(f"{short(model)} is still downloading.")
            if model in st["pending"]:   # someone else is loading it: wait for that instead of starting again
                _wait_ready(info, model, meta, job)
                return {"model": model, "loaded_now": False, "unloaded": []}
            if policy == "loaded":
                raise NotReady(f"{short(model)} isn't loaded{f', and {requester} may only use loaded models' if requester else ''}. "
                               "Load it on the Models page.")
            p = plan(model, protect, info, st, only_borrowed=policy == "borrowed")
            unloaded = []
            if not p["fits"]:
                if policy in ("make_room", "borrowed") and p["unload"]:
                    for mid in p["unload"]:
                        if job:
                            job.update(message=f"Unloading {short(mid)} to make room…")
                        _stop(info, mid)
                        unloaded.append(mid)
                    st = state(info)
                elif p["confident"] or (policy == "make_room" and p["blocked_by"]):
                    raise NotReady(describe(p) + ("" if policy == "make_room" else " Unload one on the Models page."))
                # not sure it doesn't fit (sizes are estimates): try, and let the device decide
            before = None if _num(meta.get("npu_usage")) else (st["used_mb"] if st["used_mb"] is not None else (0.0 if not st["ready"] else None))
            others = st["ready"] - {model}
            if job:
                job.update(message=f"Loading {short(model)} into NPU memory…")
            status, data, text = device.call(info, "core", "POST", f"/api/v1/models/{urllib.parse.quote(model, safe='/')}/start", timeout=180)
            if not 200 <= status < 300:
                msg = error_message(data, text, status)
                if NO_ROOM.search(msg):
                    raise NotReady(f"The device says there isn't room for {short(model)}: “{msg}”. " + describe(plan(model, protect, info)))
                raise NotReady(f"The device didn't load {short(model)}: {msg}")
            _wait_ready(info, model, meta, job)
            forget_models()
            if before is not None:
                after = state(info)
                if after["used_mb"] is not None and after["ready"] - {model} == others:
                    _record_footprint(model, meta, after["used_mb"] - before)
            return {"model": model, "loaded_now": True, "unloaded": unloaded}
        except NotReady:
            raise
        except DeviceError as e:
            raise NotReady(str(e))


@contextmanager
def use(model: str, *, policy: str = "fits", protect=(), requester: str = "", unload_after=None, why: str = ""):
    """Use a model for one piece of work (an app's request, an MCP tool): make sure it's loaded, and, when
    `unload_after` is a number of seconds, borrow it if it wasn't loaded, so the panel unloads it again that long after
    its last use (common.Borrowed). With unload_after None the model stays loaded, and if it was borrowed by someone
    else, it's kept from now on."""
    info = _ctx["devconn"].resolve()
    session, borrowed = new_id("u"), False
    try:
        try:
            if unload_after is None:
                BORROWED.keep(model)
            else:
                loaded = model in set(device.running_ids(info))
                borrowed = BORROWED.borrow(model, session, loaded=loaded, why=why or requester or "an app", after=int(unload_after))
            result = ensure_ready(model, policy=policy, protect=protect, requester=requester, info=info)
        except DeviceError as e:
            if borrowed:   # nothing was loaded: forget the borrow, unless another request holds it too
                BORROWED.give_back(model, session, int(unload_after))
                BORROWED.unloaded(model, {})
                borrowed = False
            raise e if isinstance(e, NotReady) else NotReady(str(e))
        yield result
    finally:
        if borrowed:
            BORROWED.give_back(model, session, int(unload_after))
