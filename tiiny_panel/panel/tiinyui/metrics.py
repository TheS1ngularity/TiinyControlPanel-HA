"""Performance history, model usage tracking and the idle model watcher.

A sampler thread polls the device every few seconds while the panel runs. Samples stay in memory
for 24 hours and go to small daily JSONL files for 7 days, so the History charts can show a week.
Loads and unloads are recorded as events. The chat proxy reports every completion's speed, which
feeds the speed leaderboard. When "unload idle models" is on, models nobody has used for a while
are unloaded, except pinned ones and anything the device reports as busy. Models loaded just for a moment
(🎤 and 🔊 in chats, see common.Borrowed) are unloaded again once they've been given back and nothing used them for
the wait the page asked for, whether or not that switch is on.
"""

from __future__ import annotations

import json
import statistics
import threading
import time
import urllib.parse
from collections import deque
from pathlib import Path

from . import activity, device
from .common import BORROWED, USAGE

SAMPLE_EVERY = 5
KEEP_DAYS = 7
RANGES = {"15m": 900, "1h": 3600, "6h": 6 * 3600, "24h": 86400, "7d": 7 * 86400}
FIELDS = ("npu", "npu_mem", "cpu", "ram")
CARD_MB = 49024  # the Tiiny's NPU card (LQ50-48GB), for when it doesn't report
NPU_KEYS = ("npu", "npu_mem", "npu_mem_mb", "npu_mem_total_mb")


def npu_reading(nj: dict, running) -> dict:
    """The NPU card the models run on, from /api/v1/npu/status. It reports only while a model is loaded; with nothing
    loaded it's idle. /api/v1/sys/status also lists an "NPU-0", but that's the TiinyOS widget's feed and not the card:
    with a model loaded the card said 0 % busy and 468 MB of 49,024 MB used while "NPU-0" said 67.83 % and 5,629 of
    8,920 MB, and its total memory changes from reading to reading. So it's never used for the NPU."""
    dev0 = (nj.get("devices") or [{}])[0] or {}
    used, total = dev0.get("mem_used_mb"), dev0.get("mem_total_mb")
    if isinstance(total, (int, float)) and total > 0:
        out = {"npu": _num(dev0.get("util_percent")), "npu_mem": round(100 * used / total, 2) if isinstance(used, (int, float)) else None,
               "npu_mem_mb": _num(used), "npu_mem_total_mb": _num(total)}
        if isinstance(dev0.get("temp_c"), (int, float)):
            out["temp"] = dev0["temp_c"]
        return out
    if running is not None and not running:  # nothing loaded, so nothing can run on it
        return {"npu": 0.0, "npu_mem": 0.0, "npu_mem_mb": 0.0, "npu_mem_total_mb": float(CARD_MB)}
    return dict.fromkeys(NPU_KEYS)  # a model is loaded but the card isn't reporting: unknown, not a guess


def from_widget(rec: dict) -> bool:
    """Samples recorded before this fix took NPU numbers from the widget feed when the card wasn't reporting; they
    show up as a "total" far below the card's 48 GB (3.8 to 8.9 GB)."""
    total = rec.get("npu_mem_total_mb")
    return isinstance(total, (int, float)) and total < 16384




class Metrics:
    def __init__(self, devconn, settings, jobs, root: Path):
        self.devconn, self.settings, self.jobs = devconn, settings, jobs
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.samples = deque(maxlen=int(86400 / SAMPLE_EVERY) + 10)
        self.events = deque(maxlen=5000)
        self.speeds = deque(maxlen=5000)
        self.old = []                    # samples older than 24 h, from the files (for the 7-day view)
        self.running = None              # model ids seen running at the last sample
        self.aliases = {}
        self.first_seen = {}
        self.busy = set()
        self.last_error = ""
        self.stop_event = threading.Event()
        self._load_files()

    # -- persistence ------------------------------------------------------------------------
    def _file(self, ts=None) -> Path:
        return self.root / time.strftime("%Y-%m-%d.jsonl", time.localtime(ts or time.time()))

    def _append(self, kind, rec):
        try:
            with open(self._file(rec.get("t")), "a", encoding="utf-8") as f:
                f.write(json.dumps({kind: rec}, separators=(",", ":")) + "\n")
        except OSError:
            pass

    def _load_files(self):
        cutoff = time.time() - KEEP_DAYS * 86400
        day_cut = time.time() - 86400
        for p in sorted(self.root.glob("*.jsonl")):
            try:
                if p.stat().st_mtime < cutoff - 86400:
                    p.unlink()
                    continue
                lines = p.read_text(encoding="utf-8").splitlines()
            except OSError:
                continue
            for line in lines:
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if "s" in d and d["s"].get("t", 0) >= cutoff:
                    if from_widget(d["s"]):
                        d["s"].update(dict.fromkeys(NPU_KEYS))
                    (self.samples if d["s"]["t"] >= day_cut else self.old).append(d["s"])
                elif "e" in d and d["e"].get("t", 0) >= cutoff:
                    self.events.append(d["e"])
                elif "p" in d and d["p"].get("t", 0) >= cutoff:
                    self.speeds.append(d["p"])
        self.old = self.old[-int(KEEP_DAYS * 86400 / SAMPLE_EVERY):]

    # -- sampling ------------------------------------------------------------------------------
    def start(self):
        threading.Thread(target=self._loop, daemon=True, name="metrics").start()

    def _loop(self):
        n = 0
        while not self.stop_event.wait(SAMPLE_EVERY if n else 1):
            n += 1
            try:
                self.sample()
            except Exception as e:  # noqa: BLE001 - the sampler must never die
                self.last_error = str(e)
            try:
                self.borrowed_check()
            except Exception as e:  # noqa: BLE001
                self.last_error = f"borrowed models: {e}"
            if n % 12 == 0:
                try:
                    self.idle_check()
                except Exception as e:  # noqa: BLE001
                    self.last_error = f"idle watcher: {e}"
            if n % 720 == 0:
                self._prune()

    def sample(self):
        info = self.devconn.resolve()
        if not info.get("address"):
            return
        sys_ = device.device_json(info, "core", "GET", "/api/v1/sys/status", timeout=4)
        npu = device.device_json(info, "core", "GET", "/api/v1/npu/status", timeout=4)
        run = device.device_json(info, "core", "GET", "/v1/models", timeout=4)
        if not sys_["ok"] and not npu["ok"]:
            self.last_error = npu.get("error") or sys_.get("error") or "no data"
            return
        s = (sys_["json"] or {}) if sys_["ok"] else {}
        nj = (npu["json"] or {}) if npu["ok"] else {}
        running = {m.get("id") for m in (run["json"] or {}).get("data") or [] if m.get("id")} if run["ok"] else None
        # CPU and RAM: npu/status is live; the widget feed (sys/status) can stand still (it did on TiinyOS 0.1.39)
        cpu = (nj.get("cpu") or {}).get("total_percent")
        ram = (nj.get("memory") or {}).get("usage_percent")
        rec = {"t": round(time.time(), 1), **npu_reading(nj, running),
               "cpu": _num(cpu if isinstance(cpu, (int, float)) else (s.get("cpu") or {}).get("total_percent")),
               "ram": _num(ram if isinstance(ram, (int, float)) else (s.get("memory") or {}).get("usage_percent"))}
        busy = set()
        for occ in nj.get("occupants") or []:
            for am in occ.get("activate_model") or []:
                if am.get("active_request_count") or am.get("active_tasks"):
                    busy.add(am.get("model_name"))
        with self.lock:
            self.samples.append(rec)
            self.busy = busy
        self._append("s", rec)
        if run["ok"]:
            data = (run["json"] or {}).get("data") or []
            now_ids = {m.get("id") for m in data if m.get("id")}
            self.aliases = {m["id"]: list(m.get("aliases") or []) for m in data if m.get("id")}
            if self.running is not None:
                for mid in now_ids - self.running:
                    self.event("load", mid)
                for mid in self.running - now_ids:
                    self.event("unload", mid)
            for mid in now_ids:
                self.first_seen.setdefault(mid, time.time())
            for mid in list(self.first_seen):
                if mid not in now_ids:
                    del self.first_seen[mid]
            self.running = now_ids
        self.last_error = ""

    def event(self, kind, model, detail=""):
        rec = {"t": round(time.time(), 1), "kind": kind, "model": model}
        if detail:
            rec["detail"] = detail
        with self.lock:
            self.events.append(rec)
        self._append("e", rec)

    def record_speed(self, model, ttft, tps, tokens):
        if not model or not tokens:
            return
        rec = {"t": round(time.time(), 1), "model": model, "ttft": round(ttft, 3) if ttft is not None else None,
               "tps": round(tps, 2) if tps else None, "tokens": int(tokens)}
        with self.lock:
            self.speeds.append(rec)
        self._append("p", rec)

    def _prune(self):
        cutoff = time.time() - KEEP_DAYS * 86400
        for p in self.root.glob("*.jsonl"):
            try:
                if p.stat().st_mtime < cutoff:
                    p.unlink()
            except OSError:
                pass
        with self.lock:
            self.old = [x for x in self.old if x["t"] >= cutoff]

    # -- queries -----------------------------------------------------------------------------
    def query(self, rng: str) -> dict:
        span = RANGES.get(rng, 3600)
        now = time.time()
        start = now - span
        with self.lock:
            src = (self.old if span > 86400 else []) + list(self.samples)
            pts = [x for x in src if x["t"] >= start]
            evs = [e for e in self.events if e["t"] >= start]
            last = self.samples[-1] if self.samples else None
        buckets = max(1, int(span / 720))  # at most ~720 points per chart
        step = max(SAMPLE_EVERY, buckets)
        out, cur, cur_t = [], [], None
        for x in pts:
            b = int(x["t"] // step)
            if cur_t is not None and b != cur_t:
                out.append(_avg(cur))
                cur = []
            cur_t = b
            cur.append(x)
        if cur:
            out.append(_avg(cur))
        return {"range": rng, "start": start, "end": now, "step": step, "points": out, "events": evs,
                "last": last, "error": self.last_error}

    def speed_board(self) -> list:
        with self.lock:
            rows = list(self.speeds)
        by = {}
        for r in rows:
            by.setdefault(r["model"], []).append(r)
        out = []
        for model, rs in by.items():
            tps = [r["tps"] for r in rs if r.get("tps")]
            ttft = [r["ttft"] for r in rs if r.get("ttft") is not None]
            out.append({"model": model, "runs": len(rs), "tps": round(statistics.median(tps), 1) if tps else None,
                        "tps_best": round(max(tps), 1) if tps else None, "ttft": round(statistics.median(ttft), 2) if ttft else None,
                        "last": max(r["t"] for r in rs)})
        out.sort(key=lambda r: -(r["tps"] or 0))
        return out

    # -- idle watcher --------------------------------------------------------------------------------
    def last_used(self, mid: str):
        times = [USAGE.get(mid), self.first_seen.get(mid)] + [USAGE.get(a) for a in self.aliases.get(mid, [])]
        times = [t for t in times if t]
        return max(times) if times else None

    def idle_status(self) -> list:
        out = []
        for mid in sorted(self.running or []):
            lu = self.last_used(mid)
            out.append({"id": mid, "last_used": lu, "idle_seconds": round(time.time() - lu) if lu else None,
                        "busy": mid in self.busy, "pinned": mid in (self.settings.get("keep_loaded") or [])})
        return out

    def idle_check(self):
        if not self.settings.get("idle_unload"):
            return []
        if any(not j.finished for j in self.jobs.list()):
            return []  # never while the panel is working in the background
        limit = max(1, int(self.settings.get("idle_minutes") or 30)) * 60
        keep = set(self.settings.get("keep_loaded") or [])
        info = self.devconn.resolve()
        done = []
        for mid in list(self.running or []):
            if mid in keep or mid in self.busy:
                continue
            lu = self.last_used(mid)
            if lu and time.time() - lu > limit:
                status, data, text = device.call(info, "core", "POST", f"/api/v1/models/{urllib.parse.quote(mid, safe='/')}/stop", timeout=60)
                if 200 <= status < 300:
                    self.event("auto-unload", mid, f"idle for {int((time.time() - lu) // 60)} min")
                    done.append(mid)
        return done

    # -- models loaded just for a moment (common.Borrowed) ---------------------------------------------------------
    def _alive(self, mid, mk) -> float:
        """The last sign that a page is still using a borrowed model: it said so, or it sent the model work."""
        return max(list(mk["users"].values()) + [self.last_used(mid) or 0])

    def borrowed_status(self) -> dict:
        """For the page: each borrowed model, what for, and in how many seconds it's unloaded (None while in use)."""
        now, out = time.time(), {}
        for mid, mk in BORROWED.snapshot().items():
            using = bool(mk["users"]) and now - self._alive(mid, mk) < BORROWED.HOLD_LIMIT
            last = max(mk["done"] or 0, self.last_used(mid) or 0)
            out[mid] = {"for": mk["why"], "using": using, "after": mk["after"],
                        "unload_in": None if using else max(0, round(last + mk["after"] - now))}
        return out

    def borrowed_check(self) -> list:
        """Unload the borrowed models that were given back and haven't been used since for as long as was asked."""
        marks = BORROWED.snapshot()
        running = self.running
        if not marks or running is None:   # nothing borrowed, or the device isn't answering
            return []
        now = time.time()
        keep = set(self.settings.get("keep_loaded") or [])
        busy = self.busy | activity.busy_models()
        info, done = None, []
        for mid, mk in marks.items():
            if mid in keep:
                BORROWED.keep(mid)   # pinned: it stays
                continue
            if mk["users"] and now - self._alive(mid, mk) < BORROWED.HOLD_LIMIT:
                continue             # a page is using it
            if mid not in running:
                if now - mk["since"] > 60:
                    BORROWED.keep(mid)   # not loaded (any more): nothing to unload
                continue
            if mid in busy or now - max(mk["done"] or 0, self.last_used(mid) or 0) < mk["after"]:
                continue
            if not BORROWED.unchanged(mid, mk["users"]):
                continue             # a page started using it just now
            info = info or self.devconn.resolve()
            status, _, _ = device.call(info, "core", "POST", f"/api/v1/models/{urllib.parse.quote(mid, safe='/')}/stop", timeout=30)
            if 200 <= status < 300:
                BORROWED.unloaded(mid, mk["users"])
                self.event("auto-unload", mid, f"loaded just for {mk['why']}")
                done.append(mid)
        return done


def _num(v):
    return round(float(v), 2) if isinstance(v, (int, float)) else None


def _avg(group: list) -> dict:
    out = {"t": round(sum(x["t"] for x in group) / len(group), 1)}
    for k in FIELDS + ("temp",):
        vals = [x[k] for x in group if x.get(k) is not None]
        if vals:
            out[k] = round(sum(vals) / len(vals), 2)
    mem = [x for x in group if x.get("npu_mem_mb") is not None]
    if mem:
        out["npu_mem_mb"] = mem[-1]["npu_mem_mb"]
        out["npu_mem_total_mb"] = mem[-1].get("npu_mem_total_mb")
    return out
