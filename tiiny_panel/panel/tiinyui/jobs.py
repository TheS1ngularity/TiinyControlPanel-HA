"""Background jobs (indexing, code review, studio renders...) with progress you can follow over SSE."""

from __future__ import annotations

import threading
import time
import traceback

from .common import BadRequest, DeviceError, new_id


class Cancelled(Exception):
    """Raised inside a job when the user cancels it."""


_local = threading.local()


def current():
    """The job this thread is working for, if any. The dashboard names the device's work after it."""
    return getattr(_local, "job", None)


def working_for(job):
    """Mark this thread as working for `job` (a job's own thread does this itself; helper threads it starts call it)."""
    _local.job = job if isinstance(job, Job) else None


class Job:
    def __init__(self, kind: str, title: str, meta: dict = None):
        self.id = new_id("j")
        self.kind = kind
        self.title = title
        self.meta = meta or {}
        self.status = "running"      # running | done | failed | cancelled
        self.progress = None         # 0..1, or None when unknown
        self.message = ""
        self.log = []
        self.result = None
        self.error = ""
        self.created = time.time()
        self.updated = self.created
        self.version = 0
        self.cancel_event = threading.Event()
        self.cond = threading.Condition()
        self.live = None             # what it's doing right now, for pages that follow it (a code review: the model's text)
        self.events = []             # numbered events for pages that follow it piece by piece (a chat turn); see emit()
        self.event_n = 0

    def update(self, message: str = None, progress: float = None, log: str = None):
        with self.cond:
            if message is not None:
                self.message = message
            if progress is not None:
                self.progress = max(0.0, min(1.0, float(progress)))
            if log:
                self.log.append(f"{time.strftime('%H:%M:%S')}  {log}")
                del self.log[:-400]
            self.updated = time.time()
            self.version += 1
            self.cond.notify_all()

    MAX_EVENTS = 4000

    def set_live(self, live):
        """Replace the snapshot of what the job is doing now (pages following the job see it with its next update)."""
        with self.cond:
            self.live = live
            self.updated = time.time()
            self.version += 1
            self.cond.notify_all()

    def emit(self, kind: str, data=None) -> int:
        """Add a numbered event for pages that follow the job live; a page that reconnects asks for what came after the
        last number it saw. Only the newest MAX_EVENTS are kept (the page then starts from a fresh snapshot)."""
        with self.cond:
            self.event_n += 1
            self.events.append({"n": self.event_n, "kind": kind, "data": data})
            if len(self.events) > self.MAX_EVENTS:
                del self.events[:len(self.events) - self.MAX_EVENTS]
            self.updated = time.time()
            self.version += 1
            self.cond.notify_all()
            return self.event_n

    def events_since(self, n: int):
        """(events after number n, whether that's all of them: False when older ones were dropped)."""
        with self.cond:
            evs = [e for e in self.events if e["n"] > n]
            complete = not self.events or self.events[0]["n"] <= n + 1
            return evs, complete

    def check(self):
        """Call often inside long work; raises Cancelled when the user pressed Cancel."""
        if self.cancel_event.is_set():
            raise Cancelled()

    @property
    def finished(self) -> bool:
        return self.status != "running"

    def info(self, with_log=False, with_live=False) -> dict:
        d = {"id": self.id, "kind": self.kind, "title": self.title, "meta": self.meta, "status": self.status,
             "progress": self.progress, "message": self.message, "error": self.error, "result": self.result,
             "created": self.created, "updated": self.updated, "version": self.version}
        if with_log:
            d["log"] = list(self.log[-200:])
        if with_live and self.live is not None:
            d["live"] = self.live
        return d


class JobManager:
    def __init__(self):
        self.jobs = {}
        self.lock = threading.Lock()

    def start(self, kind: str, title: str, fn, meta: dict = None) -> Job:
        job = Job(kind, title, meta)
        with self.lock:
            cutoff = time.time() - 6 * 3600
            for jid, j in list(self.jobs.items()):
                if j.finished and j.updated < cutoff:
                    del self.jobs[jid]
            self.jobs[job.id] = job

        def runner():
            working_for(job)
            try:
                result = fn(job)
                with job.cond:
                    job.result = result if result is not None else job.result
                    job.status = "cancelled" if job.cancel_event.is_set() else "done"
                    if job.status == "done" and job.progress is not None:
                        job.progress = 1.0
            except Cancelled:
                with job.cond:
                    job.status = "cancelled"
                    job.message = "Cancelled"
            except Exception as e:  # noqa: BLE001
                if isinstance(e, (DeviceError, BadRequest)):  # expected: the message says it all
                    print(f"Job {kind} {job.id} stopped: {e}")
                else:
                    traceback.print_exc()
                with job.cond:
                    job.status = "failed"
                    job.error = str(e) or e.__class__.__name__
            finally:
                job.update()

        threading.Thread(target=runner, daemon=True, name=f"job-{kind}-{job.id}").start()
        return job

    def get(self, jid: str):
        with self.lock:
            return self.jobs.get(jid)

    def list(self, kind: str = None, **meta) -> list:
        with self.lock:
            jobs = list(self.jobs.values())
        out = [j for j in jobs if (not kind or j.kind == kind) and all(j.meta.get(k) == v for k, v in meta.items())]
        return sorted(out, key=lambda j: j.created, reverse=True)

    def running(self, kind: str = None, **meta):
        return next((j for j in self.list(kind, **meta) if not j.finished), None)

    def cancel(self, jid: str) -> bool:
        job = self.get(jid)
        if not job or job.finished:
            return False
        job.cancel_event.set()
        job.update(message="Cancelling…")
        return True

    @staticmethod
    def wait(job: Job, version: int, timeout: float):
        with job.cond:
            if job.version <= version and not job.finished:
                job.cond.wait(timeout)
            return job.version
