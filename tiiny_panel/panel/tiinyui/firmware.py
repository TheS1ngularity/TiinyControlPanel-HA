"""TiinyOS updates through the device's own upgrade service (the "v2" API that its upgrade dashboard uses).

Before Tiiny's tool 0.0.6, its `upgrade` command only called the old /api/upgrade/check, which newer devices no longer
have (HTTP 404 on TiinyOS 0.1.38); 0.0.6 uses this API too. The panel checks for and installs updates itself:
  GET  /api/v2/versions           the running version and the offered ones, with release notes
  POST /api/v2/versions/refresh   ask Tiiny's update server again
  GET  /api/v2/device             whether an update may start, and whether a restart is needed to finish one
  GET  /api/v2/jobs/current       the running update: state, step, progress
  POST /api/v2/jobs               {"type": "download" | "install", "target_version": "0.1.39"}
The device only installs what it has downloaded and verified first ("target resources are not ready; run download
first"), so an update is two device jobs in a row: download, then install. The panel's server runs them one after
the other (start_update), so the update carries on when you leave the page. Only versions the device itself offers
as upgrades can be installed, never an older one. Devices without this service (/api/v2/versions is 404) keep using
the CLI.
"""

from __future__ import annotations

import re
import time
import urllib.parse

from . import device
from .common import BadRequest, DeviceError, error_message
from .jobs import Cancelled

SERVICE = "upgrade"  # Host: hardware-upgrade.api.tiiny on the device's port (see device.SERVICES)
ACTIVE = ("PENDING", "RUNNING", "PAUSING", "PAUSED", "CANCELING", "AWAITING_REBOOT")
CANCELLABLE = ("preparing", "resolving", "downloading", "verifying_resources", "waiting_network")  # before anything is installed
PHASES = {  # the device's steps, in the order an update goes through them
    "preparing": "Preparing the update",
    "resolving": "Working out what to download",
    "downloading": "Downloading the update",
    "verifying_resources": "Checking the download",
    "waiting_network": "Waiting for the network; it carries on by itself",
    "prechecking": "Checking that your Tiiny is ready",
    "quiescing": "Getting your Tiiny ready",
    "importing_images": "Preparing services",
    "installing": "Installing",
    "activating": "Preparing to activate the update",
    "awaiting_reboot": "Installed. Waiting for a restart to finish the update",
    "verifying_boot": "Waiting for your Tiiny to restart",
    "verifying_service": "Checking services",
    "confirming_boot": "Making sure your Tiiny started properly",
    "committing": "Finishing up",
    "maintaining": "Maintaining your Tiiny",
    "settling": "Saving the result",
}
TIMEOUT = 8
POLL = 2.0
AWAY_LIMIT = {"download": 10 * 60, "install": 45 * 60}  # how long the device may be out of reach in each step


def _vkey(v) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", str(v or ""))[:4])


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None  # not NaN


def _data(payload):
    return payload.get("data") if isinstance(payload, dict) and "data" in payload else payload


def _call(info, method, path, body=None, timeout=TIMEOUT):
    """(status, data) from the upgrade service; raises DeviceError when the device can't be reached."""
    status, payload, text = device.call(info, SERVICE, method, path, body=body, timeout=timeout)
    if status == 401:
        raise DeviceError("Your Tiiny's upgrade service didn't accept the API key. Log in again under Account, "
                          "or check the key under System → Panel settings.")
    if not 200 <= status < 300 and status != 404:
        raise DeviceError(error_message(payload, text, status))
    return status, _data(payload)


def _ok(info, method, path, body=None, timeout=TIMEOUT):
    status, data = _call(info, method, path, body, timeout)
    if status == 404:
        raise DeviceError("Your Tiiny's upgrade service doesn't know that request (HTTP 404).")
    return data


def describe(job) -> dict | None:
    """A device job in the panel's words: what it's doing, how far along, whether it can still be cancelled."""
    if not isinstance(job, dict) or not job:
        return None
    prog = job.get("progress") if isinstance(job.get("progress"), dict) else {}
    ex = job.get("execution") if isinstance(job.get("execution"), dict) else {}
    err = job.get("error")
    err = (err.get("message") if isinstance(err, dict) else err) or ""
    state = str(job.get("state") or job.get("status") or "").upper()
    phase = str(ex.get("phase") or "")
    kind = str(job.get("type") or "")
    pct = _num(prog.get("percent"))
    pct = None if pct is None else max(0.0, min(100.0, pct))
    detail = ""
    if state in ("PAUSING", "PAUSED", "CANCELING", "CANCELED") and phase != "settling":
        text = {"PAUSING": "Pausing…", "CANCELING": "Cancelling…", "CANCELED": "Update cancelled",
                "PAUSED": "Paused until the network is back" if job.get("pause_reason") == "network" else "Paused"}[state]
    elif phase == "settling":
        text = "The update failed; saving the result" if state == "FAILED" else "Saving the result"
        detail = err
    elif state == "AWAITING_REBOOT":  # installed; the device restarts only when asked to (see needs_restart)
        text = "Installed. Waiting for a restart to finish the update" if phase in ("awaiting_reboot", "activating", "") else "Restarting to finish the update"
    elif state == "FAILED":
        text, detail = "The update failed", err
    elif state in ("SUCCEEDED", "SUCCESS"):
        text = "Download ready" if kind == "download" else "Update installed"
    else:
        text = PHASES.get(phase) or ("Starting the update" if state == "PENDING" else "Updating")
        metric = prog.get("metric") if isinstance(prog.get("metric"), dict) else {}
        detail = str(metric.get("current_item") or "")
    tgt = job.get("target") if isinstance(job.get("target"), dict) else {}
    target = job.get("target_version") or tgt.get("version") or job.get("version") or ""
    known = prog.get("stage_progress_known")
    return {
        "id": str(job.get("id") or ""), "type": kind, "state": state, "phase": phase, "active": state in ACTIVE,
        "text": text, "detail": str(detail or "")[:300], "error": str(err)[:500],
        "percent": pct, "known": bool(known) if known is not None else pct is not None,
        "speed_bps": _num(prog.get("download_speed_bps")),
        "target_version": str(target or ""), "direction": str(job.get("direction") or ""),
        "can_cancel": state in ("PENDING", "RUNNING", "PAUSED") and (phase in CANCELLABLE or not phase),
        "restart_hint": state == "AWAITING_REBOOT" or phase in ("verifying_boot", "confirming_boot"),
    }


def status(info, job_id: str = "") -> dict:
    """What the Firmware card shows. service is "none" on devices whose updates still go through the CLI."""
    st, vers = _call(info, "GET", "/api/v2/versions")
    if st == 404:
        return {"service": "none", "reachable": True}
    vers = vers if isinstance(vers, dict) else {}
    dev = _ok(info, "GET", "/api/v2/device") or {}
    dev = dev if isinstance(dev, dict) else {}
    job = describe(_ok(info, "GET", "/api/v2/jobs/current"))
    finished = None
    if not job and job_id and re.fullmatch(r"[\w.:-]{1,80}", job_id):
        s2, data = _call(info, "GET", f"/api/v2/jobs/{urllib.parse.quote(job_id)}")
        finished = describe(data) if s2 == 200 else None
    current = str(vers.get("current_version") or (dev.get("versions") or {}).get("current") or "")
    offered = (vers.get("version_selection") or {}).get("target_versions") or []
    targets = sorted({str(v) for v in offered if _vkey(v) > _vkey(current)}, key=_vkey, reverse=True)  # upgrades only
    latest = str(vers.get("published_target") or vers.get("latest") or "")
    if latest not in targets:
        latest = targets[0] if targets else ""
    info_by_version = {str((v.get("info") or {}).get("version")): v.get("info") or {}
                       for v in vers.get("versions") or [] if isinstance(v, dict)}
    rel = info_by_version.get(latest) or {}
    gate = dev.get("execution_gate") if isinstance(dev.get("execution_gate"), dict) else {}
    admission = (dev.get("admission") or {}).get("status") if isinstance(dev.get("admission"), dict) else None
    blocked = ""
    if gate.get("status") == "blocked":
        blocked = str(gate.get("reason") or "Your Tiiny needs attention before it can update.")
    elif admission not in (None, "ready"):
        blocked = "Your Tiiny isn't ready to update right now. Try again in a minute."
    allowed = dev.get("allowed_actions") if isinstance(dev.get("allowed_actions"), list) else []
    pend = dev.get("pending_activation")
    asked = pend.get("reboot_requests") if isinstance(pend, dict) else None
    activity = (dev.get("activity") or {}).get("status") if isinstance(dev.get("activity"), dict) else None
    return {
        "service": "v2", "reachable": True,
        "current": current, "latest": latest, "targets": targets,
        "release": {"version": latest, "title": str(rel.get("title") or ""), "subtitle": str(rel.get("subtitle") or ""),
                    "notes": str(rel.get("description") or "")[:6000], "required": bool(rel.get("required"))} if latest else None,
        "fetched_at": str(vers.get("fetched_at") or ""),
        "os": str((dev.get("versions") or {}).get("os") or ""),
        "pending_activation": bool(pend),
        # installed and waiting: the device doesn't restart by itself (the official dashboard has a Reboot button for this)
        "needs_restart": bool(pend) and "reboot" in allowed and not asked,
        "restart_requested": bool(asked),
        "reboot_pending": bool(dev.get("reboot_pending")),
        "blocked": blocked,
        "can_install": bool(latest) and not job and not blocked and {"download", "install"} <= set(allowed) and activity in (None, "idle"),
        "can_reboot": "reboot" in allowed,
        "job": job, "finished_job": finished,
    }


def check(info) -> dict:
    """Ask Tiiny's update server again (what "Check for updates" means), then report."""
    _ok(info, "POST", "/api/v2/versions/refresh", timeout=60)
    return status(info)


def updater_info(jobs) -> dict | None:
    """The update this panel started most recently: running, or finished within the last hour."""
    for j in jobs.list("firmware"):
        if j.status == "running" or time.time() - j.updated < 3600:
            return {"id": j.id, "status": j.status, "message": j.message, "error": j.error,
                    "step": j.meta.get("step", ""), "version": j.meta.get("version", "")}
        break
    return None


def start_update(devconn, jobs, version):
    """Check that the device offers this version and is ready, then download and install it in the background."""
    version = str(version or "").strip()
    if not re.fullmatch(r"\d+(\.\d+){1,3}", version):
        raise BadRequest("Choose the TiinyOS version to install.")
    if jobs.running("firmware"):
        raise BadRequest("An update is already running on your Tiiny.")
    s = status(devconn.resolve())
    if s["service"] != "v2":
        raise BadRequest("This Tiiny installs updates through the tiiny CLI.")
    if s["job"]:
        raise BadRequest("An update is already running on your Tiiny.")
    if version not in s["targets"]:
        raise BadRequest(f"Your Tiiny doesn't offer TiinyOS {version} as an update (it's on {s['current'] or 'an unknown version'}).")
    if not s["can_install"]:
        raise BadRequest(s["blocked"] or "Your Tiiny can't start an update right now. Try again in a minute.")
    return jobs.start("firmware", f"Updating TiinyOS to {version}", lambda job: _update(job, devconn, version),
                      {"version": version, "step": "download"})


def _update(job, devconn, version):
    job.update(message="Downloading the update", progress=0, log=f"Download TiinyOS {version}")
    done = _follow(job, devconn, _start_job(devconn.resolve(), "download", version), "download")
    if done["state"] == "CANCELED" or job.cancel_event.is_set():
        raise Cancelled()
    if done["state"] not in ("SUCCEEDED", "SUCCESS"):
        raise DeviceError(done["error"] or "The download didn't finish.")
    job.meta["step"] = "install"
    job.update(message="Installing", progress=0, log=f"Install TiinyOS {version}")
    done = _follow(job, devconn, _start_job(devconn.resolve(), "install", version), "install")
    if done["state"] == "CANCELED":
        raise Cancelled()
    if done["state"] not in ("SUCCEEDED", "SUCCESS"):
        raise DeviceError(done["error"] or "The installation didn't finish.")
    return {"version": version}


def _start_job(info, kind, version) -> str:
    data = _ok(info, "POST", "/api/v2/jobs", {"type": kind, "target_version": version}, timeout=30)
    jid = str(data.get("id") or "") if isinstance(data, dict) else ""
    if not jid:  # not in the answer: it's the running job
        cur = describe(_ok(info, "GET", "/api/v2/jobs/current"))
        jid = cur["id"] if cur and cur["type"] == kind else ""
    if not jid:
        raise DeviceError(f"Your Tiiny didn't start the {kind}.")
    return jid


def _follow(job, devconn, jid, step) -> dict:
    """Wait for a device job to finish, mirroring its progress on the panel's job. The device may restart meanwhile."""
    away_since, asked_to_stop, ready_since, restarted = None, False, None, False
    while True:
        try:
            info = devconn.resolve()
            cur = describe(_ok(info, "GET", "/api/v2/jobs/current"))
            if not cur or cur["id"] != jid:
                code, data = _call(info, "GET", f"/api/v2/jobs/{urllib.parse.quote(jid)}")
                cur = describe(data) if code == 200 else None
                if not cur:  # the device answers but doesn't know the job any more
                    return describe({"id": jid, "state": "FAILED", "error": {"message": "Your Tiiny lost track of the update."}})
            away_since = None
            job.update(message=cur["text"], progress=cur["percent"] / 100 if cur["percent"] is not None else None)
            if not cur["active"]:
                return cur
            if step == "install" and cur["state"] == "AWAITING_REBOOT" and not restarted:
                ready_since = ready_since or time.time()
                if time.time() - ready_since > 10 and status(info).get("needs_restart"):  # it's installed and waiting
                    _ok(info, "POST", "/api/v2/device/reboot", timeout=20)
                    restarted = True
                    job.update(message="Restarting to finish the update", log="Restart to activate the update")
                    time.sleep(POLL)
                    continue
            if job.cancel_event.is_set() and not asked_to_stop and cur["can_cancel"]:
                _ok(info, "POST", f"/api/v2/jobs/{urllib.parse.quote(jid)}/cancel", timeout=20)
                asked_to_stop = True
        except DeviceError:  # out of reach: restarting, or the network dropped for a moment
            away_since = away_since or time.time()
            if time.time() - away_since > AWAY_LIMIT[step]:
                raise DeviceError(f"Your Tiiny has been out of reach for {AWAY_LIMIT[step] // 60} minutes during the {step}. "
                                  "Check that it's on and connected; System → Firmware shows how far it got.")
            job.update(message="Your Tiiny is restarting" if step == "install" else "Waiting for your Tiiny to answer")
        time.sleep(POLL)


def cancel(devconn, jobs) -> dict:
    """Stop an update while it's still downloading. Once it's installing it has to finish."""
    info = devconn.resolve()
    s = status(info)
    job = s.get("job")
    up = jobs.running("firmware")
    if job and not job["can_cancel"]:
        raise BadRequest("The update is already installing, so it can't be stopped now. Let it finish.")
    if not up and not job:
        raise BadRequest("No update is running.")
    if up:
        jobs.cancel(up.id)
    if job:
        _ok(info, "POST", f"/api/v2/jobs/{urllib.parse.quote(job['id'])}/cancel", timeout=20)
    return status(info, job["id"] if job else "")


def reboot(info) -> dict:
    """The one restart that activates an installed update (the device says so with pending_activation)."""
    s = status(info)
    if not s.get("can_reboot"):
        raise BadRequest("Your Tiiny can't restart right now.")
    _ok(info, "POST", "/api/v2/device/reboot", timeout=20)
    return {"rebooting": True}
