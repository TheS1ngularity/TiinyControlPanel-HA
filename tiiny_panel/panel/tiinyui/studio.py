"""The gallery (everything the device made) and long-running studio jobs: music, image-to-3D and video.

Studio work runs as server jobs, so it keeps going when the browser tab is closed. Results land in
the gallery collection of the store: one record per item, its files in the record's blob folder.
"""

from __future__ import annotations

import base64
import json
import re
import shutil
import struct
import tempfile
import threading
import time
import urllib.parse
import zipfile
from pathlib import Path

from . import activity, decide, device, jobs, npu
from .common import BadRequest, DeviceError, error_message, guess_mime, safe_name, valid_id
from .jobs import Cancelled

KINDS = ("image", "audio", "model3d", "video")
EDITABLE = ("title", "favorite", "notes")
MAX_BATCH = 10_000  # items one request may delete or favourite (the Gallery's "Select all")
# Picture tags a decision model gives (System → Decision models): key → the yes/no question. Kept at 50 % or more.
GALLERY_TAGS = {
    "people": "Are there people in the picture?",
    "animals": "Are there animals in the picture?",
    "nature": "Is it a landscape or a nature scene?",
    "food": "Is there food or drink in the picture?",
    "buildings": "Are there buildings or a city in the picture?",
    "vehicles": "Are there vehicles in the picture?",
    "text": "Is there readable text in the picture?",
    "art": "Is it a painting, a drawing or abstract art rather than a photo?",
}
MUSIC_CONFIG = ("lyrics", "caption", "generation_type", "seconds_total", "preview_seconds", "steps", "seed",
                "temperature", "top_k", "top_p")
MUSIC_SAMPLING = ("steps", "seed", "temperature", "top_k", "top_p")
STAGE_LABEL = {"background": "Removing the background", "shape": "Building the shape", "simplify": "Simplifying the mesh",
               "texture": "Painting the texture", "export": "Exporting the model"}


def _q(model_id: str) -> str:
    return urllib.parse.quote(model_id or "", safe="")


def run_abortable(owner, fn, *args, **kwargs):
    """Run a blocking device call in a helper thread, so Cancel ends the job (owner) right away."""
    box = {}

    def target():
        jobs.working_for(owner)  # the device's work shows under this job on the dashboard
        try:
            box["result"] = fn(*args, **kwargs)
        except BaseException as e:  # noqa: BLE001 - handed to the job thread
            box["error"] = e

    t = threading.Thread(target=target, daemon=True)
    t.start()
    while t.is_alive():
        t.join(0.5)
        owner.check()
    if "error" in box:
        raise box["error"]
    return box["result"]


DEVICE_UPLOAD_LIMIT = 200 * 1024 * 1024
# /3d/capabilities names some inputs differently from the upload field the server reads
FORM_FIELD = {"material_artifact": "material", "mesh_glb": "mesh"}
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def png_has_alpha(path) -> bool:
    """A PNG that can be transparent: grey+alpha or RGBA, or a palette/colour key with a tRNS chunk."""
    try:
        with open(path, "rb") as f:
            if f.read(8) != PNG_SIGNATURE:
                return False
            while True:
                head = f.read(8)
                if len(head) < 8:
                    return False
                n, kind = struct.unpack(">I4s", head)
                if kind == b"IHDR":
                    ihdr = f.read(n)
                    if len(ihdr) < 13:
                        return False
                    if ihdr[9] in (4, 6):  # colour type: grey + alpha, RGBA
                        return True
                    f.seek(4, 1)
                    continue
                if kind == b"tRNS":
                    return True
                if kind in (b"IDAT", b"IEND"):
                    return False
                f.seek(n + 4, 1)
    except OSError:
        return False


def compact_zip(path: Path) -> Path:
    """The device sends its 3D intermediate files as uncompressed ZIPs. Packing them again with fast
    deflate halves the next uploads and keeps the last step under the device's 200 MB request limit."""
    try:
        with zipfile.ZipFile(path) as zi:
            infos = zi.infolist()
            if not any(i.compress_type == zipfile.ZIP_STORED and i.file_size > 1 << 20 for i in infos):
                return path
            out = path.with_name("z-" + path.name)
            with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as zo:
                for i in infos:
                    with zi.open(i) as src, zo.open(i.filename, "w", force_zip64=True) as dst:
                        shutil.copyfileobj(src, dst, 1 << 20)
    except (zipfile.BadZipFile, OSError):
        return path
    path.unlink(missing_ok=True)
    return out


def _title_from(text: str, fallback: str) -> str:
    text = re.sub(r"\[[^\]]*\]", " ", text or "")
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return fallback
    return text if len(text) <= 60 else text[:57].rsplit(" ", 1)[0] + "…"


class Gallery:
    def __init__(self, store, runtime):
        self.store, self.rt = store, runtime

    @staticmethod
    def summary(rec: dict) -> dict:
        keep = ("id", "kind", "title", "prompt", "model", "source", "favorite", "created", "updated", "parent_id", "tags",
                "duration", "width", "height", "files", "params")
        return {k: rec.get(k) for k in keep}

    def list(self, kind: str = None) -> list:
        recs = self.store.list("gallery", where={"kind": kind} if kind else None)
        recs.sort(key=lambda r: r.get("created") or 0, reverse=True)  # newest first: favouriting or renaming doesn't move an item
        return [self.summary(r) for r in recs]

    def get(self, gid: str) -> dict:
        rec = self.store.get("gallery", gid)
        if not rec:
            raise BadRequest("That item is no longer in the gallery.")
        return rec

    def add_files(self, kind: str, files: list, meta: dict, move: bool = False) -> dict:
        """files: [(local_path, name, role)]. The first file with role 'main' is what the gallery shows."""
        if kind not in KINDS:
            raise BadRequest("Unknown gallery kind")
        rec = {k: v for k, v in meta.items() if v is not None}
        rec.update(kind=kind, files=[])
        rec.setdefault("title", _title_from(meta.get("prompt") or "", kind.capitalize()))
        rec = self.store.put("gallery", rec)
        folder = self.store.blob_dir("gallery", rec["id"])
        entries, used = [], set()
        for src, name, role in files:
            name = safe_name(name) or "file"
            stem, dot, ext = name.rpartition(".")
            n = 2
            while name in used:
                name = f"{stem or ext}-{n}{dot}{ext if stem else ''}"
                n += 1
            used.add(name)
            dest = folder / name
            if move:
                shutil.move(src, dest)
            else:
                shutil.copyfile(src, dest)
            entries.append({"name": name, "role": role, "mime": guess_mime(name), "size": dest.stat().st_size})
        return self.store.update("gallery", rec["id"], lambda r: r.update(files=entries))

    def add(self, spec: dict) -> dict:
        """From the page: files already in the runtime registry (uploads or device outputs)."""
        kind = spec.get("kind")
        files = []
        for f in spec.get("files") or ([{"file_id": spec.get("file_id"), "role": "main"}] if spec.get("file_id") else []):
            rec = self.rt.get_file(str(f.get("file_id", "")))
            if not rec or not Path(rec["path"]).is_file():
                raise BadRequest("That file has expired. Generate it again.")
            files.append((rec["path"], f.get("name") or rec["name"], f.get("role") or "main"))
        if not files:
            raise BadRequest("Nothing to add")
        meta = {k: spec.get(k) for k in ("title", "prompt", "negative_prompt", "model", "source", "parent_id", "width", "height", "duration")}
        meta["params"] = spec.get("params") if isinstance(spec.get("params"), dict) else {}
        return self.add_files(kind, files, meta)

    def update(self, gid: str, patch: dict) -> dict:
        def apply(r):
            for k in EDITABLE:
                if k in patch:
                    r[k] = bool(patch[k]) if k == "favorite" else str(patch[k])[:2000]
        return self.store.update("gallery", gid, apply)

    def delete(self, gid: str):
        self.store.delete("gallery", gid)

    @staticmethod
    def _ids(ids) -> list:
        """The ids of a selection, checked before anything changes (so a bad one can't stop a batch halfway)."""
        if not isinstance(ids, list) or not ids:
            raise BadRequest("Choose one or more items in the gallery first.")
        if len(ids) > MAX_BATCH or not all(valid_id(i) for i in ids):
            raise BadRequest("Those aren't items in the gallery.")
        return list(dict.fromkeys(ids))

    def delete_many(self, ids) -> dict:
        """Delete the items selected in the Gallery. Ones already gone (deleted in another window) are listed, not an error."""
        deleted, missing = [], []
        for gid in self._ids(ids):
            (deleted if self.store.delete("gallery", gid) else missing).append(gid)
        return {"deleted": deleted, "missing": missing}

    def favorite_many(self, ids, favorite: bool) -> dict:
        items, missing = [], []
        for gid in self._ids(ids):
            try:
                rec = self.store.update("gallery", gid, lambda r: r.update(favorite=bool(favorite)))
            except BadRequest:  # the ids are valid, so it was deleted meanwhile
                missing.append(gid)
                continue
            items.append(self.summary(rec))
        return {"items": items, "missing": missing}

    # -- tags from a decision model ---------------------------------------------------------------------------------
    _tag_queue: list = []
    _tag_lock = threading.Lock()
    _tag_worker = None

    def tag(self, devconn, gid: str) -> list:
        """Tag one picture from its small thumbnail. Raises decide.Unavailable when no decision model can answer."""
        rec = self.get(gid)
        if rec.get("kind") != "image":
            return []
        files = {f["role"]: f for f in rec.get("files") or []}
        f = files.get("thumb") or files.get("main")
        path = self.store.blob_dir("gallery", gid, create=False) / f["name"] if f else None
        if not path or not path.is_file() or path.stat().st_size > 6_000_000:
            return []
        mime = guess_mime(path.name) or "image/jpeg"
        image = f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()
        out = decide.decide(devconn, None, "gallery_tags", "A picture from the user's gallery.",
                            {k: {"type": "noul", "instructions": q} for k, q in GALLERY_TAGS.items()}, images=[image], timeout=120)
        tags = [k for k in GALLERY_TAGS if (out["answers"].get(k) or {}).get("yes", 0) >= 0.5]
        self.store.update("gallery", gid, lambda r: r.update(tags=tags, tags_model=out["model"]))
        return tags

    def tag_later(self, devconn, gid: str):
        """A new picture: tag it in the background, one at a time (a decision model may have to load first)."""
        with self._tag_lock:
            self._tag_queue.append(gid)
            if self._tag_worker and self._tag_worker.is_alive():
                return
            def work():
                while True:
                    with self._tag_lock:
                        if not self._tag_queue:
                            return
                        nxt = self._tag_queue.pop(0)
                    try:
                        with activity.labelled("Tagging a new picture", "gallery"):
                            self.tag(devconn, nxt)
                    except (decide.Unavailable, BadRequest, OSError):
                        with self._tag_lock:  # no decision model, or it doesn't fit: not now
                            self._tag_queue.clear()
                        return
                    except Exception:  # noqa: BLE001 - tagging is extra; never break saving a picture
                        continue
            type(self)._tag_worker = threading.Thread(target=work, daemon=True, name="gallery-tags")
            self._tag_worker.start()

    def tag_all(self, job, devconn, again: bool = False) -> dict:
        """Tag every picture without tags (or all of them again)."""
        todo = [r["id"] for r in self.store.list("gallery", where={"kind": "image"}) if again or "tags" not in r]
        done = 0
        for n, gid in enumerate(todo, 1):
            job.check()
            job.update(message=f"Tagging picture {n} of {len(todo)}…", progress=(n - 1) / max(1, len(todo)))
            try:
                self.tag(devconn, gid)
                done += 1
            except decide.Unavailable as e:
                raise DeviceError(str(e))
            except BadRequest:  # deleted meanwhile
                continue
        job.update(message=f"Tagged {done} picture(s)", progress=1)
        return {"tagged": done}

    def file_path(self, gid: str, name: str) -> Path:
        rec = self.get(gid)
        entry = next((f for f in rec.get("files", []) if f["name"] == name), None)
        if not entry:
            raise BadRequest("That file isn't part of this item.")
        p = self.store.blob_dir("gallery", gid, create=False) / entry["name"]
        if not p.is_file():
            raise BadRequest("That file is missing.")
        return p

    def main_file(self, gid: str, role: str = "main") -> Path:
        rec = self.get(gid)
        entry = next((f for f in rec.get("files", []) if f["role"] == role), None)
        if not entry:
            raise BadRequest("That item has no such file.")
        return self.file_path(gid, entry["name"])


class Studio:
    def __init__(self, store, devconn, jobs, runtime, gallery):
        self.store, self.devconn, self.jobs, self.rt, self.gallery = store, devconn, jobs, runtime, gallery

    def _workdir(self) -> Path:
        d = self.rt.work / "studio"
        d.mkdir(parents=True, exist_ok=True)
        return Path(tempfile.mkdtemp(dir=d))

    def _input_file(self, spec: dict, key: str = "image"):
        """(path, name) of an input given as a gallery item or a runtime file id."""
        gid = spec.get(f"{key}_gallery_id")
        if gid:
            p = self.gallery.main_file(str(gid))
            return p, p.name
        fid = spec.get(f"{key}_file_id")
        if fid:
            rec = self.rt.get_file(str(fid))
            if not rec or not Path(rec["path"]).is_file():
                raise BadRequest("That file has expired. Please choose it again.")
            return Path(rec["path"]), rec["name"]
        return None, None

    def control(self, jid: str, action: str) -> dict:
        job = self.jobs.get(jid)
        if not job or job.finished:
            raise BadRequest("That job isn't running.")
        if action not in ("pause", "resume") or job.kind != "model3d":
            raise BadRequest("This job can't be paused.")
        self._control_model3d(job, action)
        return job.info()

    # -- music ------------------------------------------------------------------------------
    def start_music(self, spec: dict):
        if self.jobs.running("music"):
            raise BadRequest("A song is already being made. Wait for it to finish (the model makes one at a time).")
        mode = spec.get("mode") if spec.get("mode") in ("full", "preview", "resume") else "full"
        if not spec.get("model"):
            raise BadRequest("Choose a music model")
        cfg = spec.get("config") if isinstance(spec.get("config"), dict) else {}
        if mode == "resume":
            parent = self.gallery.get(str(spec.get("parent_id", "")))
            if not (parent.get("params") or {}).get("session_id") or (parent.get("params") or {}).get("resumed"):
                raise BadRequest("That preview can't be continued any more (each preview can be continued once).")
            title = re.sub(r"^Preview: ", "", parent.get("title") or "Song")
        else:
            if not str(cfg.get("lyrics") or "").strip() and cfg.get("generation_type") != "bgm":
                raise BadRequest("Write some lyrics first (or choose “Instrumental only”).")
            title = _title_from(cfg.get("caption") or cfg.get("lyrics") or "", "Song")
        label = {"full": "Making a song", "preview": "Making a preview", "resume": "Finishing the song"}[mode]
        return self.jobs.start("music", f"{label}: {title}", lambda job: self._music_job(job, spec, mode, title),
                               {"mode": mode, "model": spec["model"], "title": title})

    def _music_job(self, job, spec, mode, title):
        info = self.devconn.resolve()
        model = spec["model"]
        npu.ensure_ready(model, policy="fits", job=job, info=info)
        cfg = {}
        src_cfg = spec.get("config") if isinstance(spec.get("config"), dict) else {}
        parent = None
        if mode == "resume":
            parent = self.gallery.get(str(spec["parent_id"]))
            base = dict((parent.get("params") or {}).get("config") or {})
            base.pop("preview_seconds", None)
            base.pop("seconds_total", None)
            for k in MUSIC_SAMPLING:
                if src_cfg.get(k) not in (None, ""):
                    base[k] = src_cfg[k]
            cfg = base
        else:
            for k in MUSIC_CONFIG:
                v = src_cfg.get(k)
                if v in (None, "") or (k == "preview_seconds" and mode != "preview"):
                    continue
                cfg[k] = v
            if mode == "preview":
                cfg.setdefault("preview_seconds", 8)
        for k in ("steps", "seed", "top_k", "seconds_total", "preview_seconds"):
            if k in cfg:
                cfg[k] = int(float(cfg[k]))
        for k in ("temperature", "top_p"):
            if k in cfg:
                cfg[k] = float(cfg[k])
        public_cfg = dict(cfg)
        ref_path, _ = self._input_file(spec, "reference")
        if ref_path and mode != "resume":
            cfg["reference_audio_base64"] = base64.b64encode(ref_path.read_bytes()).decode("ascii")
            public_cfg["reference"] = True
        body = {"model": model, "config": cfg}
        work = self._workdir()
        t0 = time.time()
        try:
            job.update(message={"preview": "Composing a short preview…", "resume": "Continuing to the full song…",
                                "full": "Composing the song…"}[mode], log=f"{mode} with {model}")
            files, session_id, sample_rate, duration = [], None, None, None
            if mode == "full" and cfg.get("generation_type") != "separate":
                wav = work / "song.wav"
                status, hdrs, size, err = run_abortable(job, device.download, info, "core", "POST", "/v1/music/generate/wav", wav,
                                                        body=body, timeout=3600, job=job)
                if err:
                    raise DeviceError(err)
                files.append((str(wav), "song.wav", "main"))
                session_id = hdrs.get("x-session-id")
            else:
                path = {"preview": "/v1/music/generate/preview", "resume": "/v1/music/generate/resume", "full": "/v1/music/generate"}[mode]
                if mode == "resume":
                    body["session_id"] = parent["params"]["session_id"]
                status, data, text = run_abortable(job, device.call, info, "core", "POST", path, body=body, timeout=3600, max_bytes=1024 ** 3)
                if not 200 <= status < 300 or not isinstance(data, dict):
                    raise DeviceError(error_message(data, text, status))
                if data.get("success") is False:
                    raise DeviceError(str(data.get("error") or data.get("message") or "The model couldn't make that song"))
                job.check()
                wav = work / "song.wav"
                wav.write_bytes(base64.b64decode(data.get("audio_data") or ""))
                if wav.stat().st_size < 100:
                    raise DeviceError("The model returned no audio")
                files.append((str(wav), "song.wav", "main"))
                for part, b64 in (data.get("audio_outputs") or {}).items():
                    if isinstance(b64, str) and b64 and part != "mixed":
                        p = work / f"{safe_name(part)}.wav"
                        p.write_bytes(base64.b64decode(b64))
                        files.append((str(p), f"{safe_name(part)}.wav", safe_name(part)))
                session_id = data.get("session_id")
                sample_rate, duration = data.get("sample_rate"), data.get("duration")
            if mode == "full" and session_id:  # the same song as MP3, when the device offers it
                mp3 = work / "song.mp3"
                try:
                    st, _, size, err = device.download(info, "core", "GET", f"/v1/music/sessions/{_q(session_id)}/download?format=mp3", mp3, timeout=300)
                    if not err and size > 1000:
                        files.append((str(mp3), "song.mp3", "mp3"))
                except DeviceError:
                    pass
            if duration is None:
                duration = _wav_seconds(Path(files[0][0]))
            secs = round(time.time() - t0)
            params = {"mode": mode, "config": public_cfg, "seconds_taken": secs}
            if mode == "preview" and session_id:
                params["session_id"] = session_id
            rec = self.gallery.add_files("audio", files, {
                "title": title if mode != "preview" else f"Preview: {title}", "prompt": public_cfg.get("caption") or "",
                "model": model, "source": "studio", "duration": duration, "params": params,
                "parent_id": parent["id"] if parent else None})
            if parent:
                self.store.update("gallery", parent["id"], lambda r: r.setdefault("params", {}).update(resumed=True, full_id=rec["id"]))
            job.update(message=f"Done in {secs} s", progress=1, log=f"saved {rec['id']}")
            return {"gallery_id": rec["id"], "seconds": secs}
        finally:
            shutil.rmtree(work, ignore_errors=True)

    # -- image to 3D ---------------------------------------------------------------------------
    def start_3d(self, spec: dict):
        if self.jobs.running("model3d"):
            raise BadRequest("A 3D model is already being made. Wait for it to finish.")
        img, name = self._input_file(spec, "image")
        if not img:
            raise BadRequest("Choose an image first")
        if not spec.get("model"):
            raise BadRequest("Choose a 3D model")
        cutout, _ = self._input_file(spec, "cutout")  # the picture with its background already removed (Studio's AI cut-out)
        if cutout and not png_has_alpha(cutout):
            raise BadRequest("The cut-out has to be a PNG with a transparent background.")
        title = str(spec.get("title") or "").strip()
        if not title and spec.get("image_gallery_id"):
            title = self.gallery.get(str(spec["image_gallery_id"])).get("title") or ""
        title = title or _title_from(Path(name).stem.replace("_", " ").replace("-", " "), "3D model")
        return self.jobs.start("model3d", f"Making a 3D model: {title}", lambda job: self._3d_job(job, spec, img, name, title, cutout),
                               {"model": spec["model"], "title": title})

    def _3d_post(self, info, job, stage, params, files):
        for attempt in range(3):
            try:
                data = device.post_multipart(info, "core", "/v1/3d/tasks", {"stage": stage, "params": json.dumps(params)}, files, timeout=1800)
                return (data or {}).get("data", data) or {}
            except DeviceError as e:
                if "429" in str(e) or re.search(r"another .*running|busy", str(e), re.I):
                    job.update(message="Waiting for another 3D task on the device to finish…")
                    for _ in range(10):
                        job.check()
                        time.sleep(3)
                    continue
                raise
        raise DeviceError("The device is busy with another 3D task.")

    def _control_model3d(self, job, action):
        tid = job.meta.get("task_id")
        if not tid:
            raise BadRequest("Nothing to pause right now; try again in a moment.")
        info = self.devconn.resolve()
        device.call_ok(info, "core", "POST", f"/v1/3d/tasks/{_q(tid)}/{action}", timeout=30)
        job.meta["paused"] = action == "pause"
        job.update(log=f"{action} requested")

    def _3d_job(self, job, spec, img_path, img_name, title, cutout=None):
        info = self.devconn.resolve()
        model = spec["model"]
        npu.ensure_ready(model, policy="fits", job=job, info=info)
        opts = spec.get("options") if isinstance(spec.get("options"), dict) else {}
        caps = (device.call_ok(info, "core", "GET", "/v1/3d/capabilities", timeout=30) or {})
        caps = caps.get("data", caps) or {}
        stages_avail = caps.get("stages") or ["background", "shape", "simplify", "texture", "export"]
        specs = caps.get("stage_specs") or {}
        plan = [s for s in ("background", "shape", "simplify", "texture", "export") if s in stages_avail]
        if cutout or not opts.get("remove_background", True):  # a cut-out is already without its background
            plan = [s for s in plan if s != "background"]
        if not opts.get("simplify", True):
            plan = [s for s in plan if s != "simplify"]
        if not opts.get("texture", True):
            plan = [s for s in plan if s not in ("texture", "export")]
        work = self._workdir()
        pool = {"image": (str(img_path), img_name)}   # artifact type -> (path, filename)
        notes = []
        if cutout:
            pool["image_no_bg"] = (str(cutout), "input-no-background.png")
            by = re.sub(r"[^\w .+-]", "", str(spec.get("cutout_model") or "").split("/")[-1])[:80]
            notes.append(f"Background removed by {by}." if by else "Background removed before the 3D steps.")
        t0 = time.time()
        try:
            for i, stage in enumerate(plan):
                job.check()
                sp = specs.get(stage) or {}
                allowed = set((sp.get("params") or {}).keys()) | set(sp.get("controls") or []) | set((caps.get("params") or {}).get(stage) or [])
                wanted = {"seed": opts.get("seed"), "output_precision": opts.get("precision"), "inference_quality": opts.get("quality"),
                          "asset_quality": opts.get("quality"), "target_faces": opts.get("target_faces"), "texture_size": opts.get("texture_size")}
                params = {k: v for k, v in wanted.items() if v not in (None, "") and (k in allowed or not allowed)}
                files, missing = [], []
                for inp in (sp.get("required_inputs") or self._default_inputs(stage)) + [x for x in sp.get("optional_inputs") or [] if x != "mesh_glb"]:
                    src = self._pick_input(stage, inp, pool)
                    if src:
                        files.append((FORM_FIELD.get(inp, inp), src[0], src[1]))
                    elif inp in (sp.get("required_inputs") or self._default_inputs(stage)):
                        missing.append(inp)
                if missing:
                    raise DeviceError(f"The {stage} step needs {', '.join(missing)}, which an earlier step didn't produce.")
                required = {FORM_FIELD.get(x, x) for x in sp.get("required_inputs") or self._default_inputs(stage)}
                while sum(Path(f[1]).stat().st_size for f in files) > DEVICE_UPLOAD_LIMIT - (1 << 20):
                    optional = [f for f in files if f[0] not in required]
                    if not optional:
                        raise DeviceError(f"The {stage} step would need more than 200 MB of data, the most the device accepts. "
                                          "Try a lower detail level.")
                    files.remove(optional[-1])
                    notes.append(f"{optional[-1][0].replace('_', ' ')} was left out of the {stage} step to stay under the device's 200 MB limit.")
                base = i / len(plan)
                label = STAGE_LABEL.get(stage, stage)
                big = sum(Path(f[1]).stat().st_size for f in files)
                job.update(message=f"{label}: sending {big / 1e6:.0f} MB to the device…" if big > 20e6 else f"{label}…",
                           progress=base, log=f"{stage}: {params}")
                try:
                    task = run_abortable(job, self._3d_post, info, job, stage, params, files)
                    result = self._3d_poll(info, job, task.get("task_id"), stage, base, 1 / len(plan))
                except DeviceError as e:
                    if stage == "background":
                        notes.append(f"Background removal isn't working on the device ({e}); the original image was used.")
                        job.update(log=f"background skipped: {e}")
                        continue
                    raise
                arts = ((result.get("result") or {}).get("output") or {}).get("artifacts") or []
                for a in arts:
                    atype, fname = a.get("artifact_type") or "", a.get("filename") or "artifact"
                    preview = atype.endswith("_preview")
                    if stage == "export":
                        needed = True
                    elif stage == plan[-1]:
                        needed = preview      # no texture step: the untextured preview is the result
                    else:
                        needed = not preview  # intermediate files the next steps need
                    if not needed:
                        continue
                    dest = work / safe_name(f"{stage}-{fname}")
                    job.update(message=f"{label}: downloading {fname}…")
                    st, _, size, err = device.download(info, "core", "GET", f"/v1/3d/tasks/{_q(task['task_id'])}/artifacts/{_q(a['artifact_id'])}",
                                                       dest, timeout=1800, job=job)
                    if err:
                        raise DeviceError(f"Couldn't download {fname}: {err}")
                    if dest.suffix.lower() == ".zip":
                        dest = compact_zip(dest)
                    pool[atype] = (str(dest), fname)
                    if (a.get("mime_type") or "").startswith("image/") and stage == "background":
                        pool["image_no_bg"] = (str(dest), fname)
                    job.update(log=f"  {stage}: {atype} {fname} {size / 1e6:.1f} MB")
            glb = self._final_glb(pool, plan)
            if not glb:
                raise DeviceError("The device finished but didn't return a 3D model file.")
            secs = round(time.time() - t0)
            files = [(glb[0], "model.glb", "main"), (str(img_path), "input" + (Path(img_name).suffix or ".png"), "input")]
            if "image_no_bg" in pool:
                files.append((pool["image_no_bg"][0], "input-no-background.png", "input_nobg"))
            rec = self.gallery.add_files("model3d", files, {
                "title": title, "prompt": "", "model": model, "source": "studio",
                "parent_id": spec.get("image_gallery_id"),
                "params": {"options": opts, "stages": plan, "seconds_taken": secs, "notes": notes}})
            job.update(message=f"Done in {secs // 60} min {secs % 60} s", progress=1, log=f"saved {rec['id']}")
            return {"gallery_id": rec["id"], "seconds": secs, "notes": notes}
        finally:
            shutil.rmtree(work, ignore_errors=True)

    @staticmethod
    def _default_inputs(stage):
        return {"background": ["image"], "shape": ["image"], "simplify": ["mesh"], "texture": ["image", "mesh"], "export": ["material"]}.get(stage, [])

    @staticmethod
    def _pick_input(stage, inp, pool):
        if inp == "image":
            return pool.get("image") if stage == "background" else (pool.get("image_no_bg") or pool.get("image"))
        if inp.endswith("_artifact"):
            return pool.get(inp[: -len("_artifact")])
        if inp == "mesh":  # Hunyuan3D naming: the simplified mesh if there is one
            return pool.get("simplified") or pool.get("geometry") or pool.get("shape")
        return pool.get(inp)

    @staticmethod
    def _final_glb(pool, plan):
        glbs = [(t, v) for t, v in pool.items() if v[1].lower().endswith(".glb")]
        for prefer in ("export", "painted", "mesh", "model", "geometry_preview", "shape_preview"):
            for t, v in glbs:
                if t == prefer or prefer in t or Path(v[0]).name.startswith(f"{prefer}-"):
                    return v
        return glbs[-1][1] if glbs else None

    def _3d_poll(self, info, job, tid, stage, base, span):
        if not tid:
            raise DeviceError("The device didn't start the task")
        job.meta["task_id"] = tid
        label = STAGE_LABEL.get(stage, stage)
        last = None
        try:
            while True:
                try:
                    job.check()
                except Cancelled:
                    try:
                        device.call(info, "core", "POST", f"/v1/3d/tasks/{_q(tid)}/cancel", timeout=20)
                    except DeviceError:
                        pass
                    raise
                time.sleep(3)
                status, data, text = device.call(info, "core", "GET", f"/v1/3d/tasks/{_q(tid)}", timeout=30)
                if status == 404:
                    raise DeviceError("The device lost the task (was it restarted?)")
                if not 200 <= status < 300:
                    continue
                d = (data or {}).get("data", data) or {}
                st = d.get("status")
                pct = d.get("progress") if isinstance(d.get("progress"), (int, float)) else 0
                if st == "completed":
                    return d
                if st in ("error", "cancelled"):
                    raise DeviceError(str(d.get("error") or d.get("message") or st))
                detail = str(d.get("runtime_stage") or d.get("message") or st or "").replace("_", " ")
                if st in ("paused", "pausing"):
                    detail = "paused"
                elif st == "waiting_for_device_reset":
                    detail = "waiting for the device to reset"
                cur = (st, pct, detail)
                if cur != last:
                    job.update(message=f"{label}: {detail} ({int(pct)}%)", progress=base + span * pct / 100)
                    last = cur
        finally:
            job.meta.pop("task_id", None)
            job.meta.pop("paused", None)

    # -- video ------------------------------------------------------------------------------------
    def start_video(self, spec: dict):
        if not str(spec.get("prompt") or "").strip():
            raise BadRequest("Describe the video first")
        if not spec.get("model"):
            raise BadRequest("Choose a video model")
        title = _title_from(spec["prompt"], "Video")
        return self.jobs.start("video", f"Making a video: {title}", lambda job: self._video_job(job, spec, title),
                               {"model": spec["model"], "title": title})

    def _video_job(self, job, spec, title):
        info = self.devconn.resolve()
        model = spec["model"]
        npu.ensure_ready(model, policy="fits", job=job, info=info)
        fields = {"model": model, "prompt": str(spec["prompt"]).strip()}
        for k in ("negative_prompt", "size", "seconds", "frames", "fps", "steps", "seed", "guidance_scale"):
            v = spec.get(k)
            if v not in (None, ""):
                fields[k] = v
        ref, ref_name = self._input_file(spec, "reference")
        job.update(message="Sending the job to the device…", log=f"video {fields}")
        t0 = time.time()
        if ref:
            data = device.post_multipart(info, "core", "/v1/videos", {k: str(v) for k, v in fields.items()},
                                         [("input_reference", str(ref), ref_name)], timeout=300)
        else:
            data = device.call_ok(info, "core", "POST", "/v1/videos", body=fields, timeout=300)
        vid = (data or {}).get("id")
        if not vid:
            raise DeviceError("The device didn't start the video job")
        job.meta["video_id"] = vid
        work = self._workdir()
        try:
            while True:
                try:
                    job.check()
                except Cancelled:
                    try:
                        device.call(info, "core", "DELETE", f"/v1/videos/{_q(vid)}", timeout=20)
                    except DeviceError:
                        pass
                    raise
                time.sleep(3)
                status, d, text = device.call(info, "core", "GET", f"/v1/videos/{_q(vid)}", timeout=30)
                if status == 404:
                    raise DeviceError("The device lost the video job (it may have restarted)")
                if not 200 <= status < 300 or not isinstance(d, dict):
                    continue
                st, pct = d.get("status"), d.get("progress") or 0
                if st == "completed":
                    break
                if st == "failed":
                    err = d.get("error") or {}
                    raise DeviceError(str(err.get("message") if isinstance(err, dict) else err) or "The video failed")
                job.update(message="Waiting in the device's queue…" if st == "queued" else f"Rendering… {int(pct)}%",
                           progress=float(pct) / 100 * 0.97)
            mp4 = work / "video.mp4"
            job.update(message="Downloading the video…", progress=0.98)
            st, hdrs, size, err = device.download(info, "core", "GET", f"/v1/videos/{_q(vid)}/content", mp4, timeout=900, job=job)
            if err:
                raise DeviceError(err)
            try:
                device.call(info, "core", "DELETE", f"/v1/videos/{_q(vid)}", timeout=20)  # frees the device's result memory
            except DeviceError:
                pass
            secs = round(time.time() - t0)
            files = [(str(mp4), "video.mp4", "main")]
            if ref:
                files.append((str(ref), "reference" + (Path(ref_name).suffix or ".png"), "input"))
            w, hgt = (str(fields.get("size") or "x").split("x") + [None])[:2]
            rec = self.gallery.add_files("video", files, {
                "title": title, "prompt": fields["prompt"], "negative_prompt": fields.get("negative_prompt"), "model": model,
                "source": "studio", "parent_id": spec.get("reference_gallery_id"),
                "width": int(hdrs.get("x-width") or w or 0) or None, "height": int(hdrs.get("x-height") or hgt or 0) or None,
                "duration": (int(hdrs["x-frames"]) / int(hdrs["x-fps"])) if hdrs.get("x-frames") and hdrs.get("x-fps") else None,
                "params": {k: v for k, v in fields.items() if k not in ("model", "prompt")} | {"seconds_taken": secs}})
            job.update(message=f"Done in {secs} s", progress=1)
            return {"gallery_id": rec["id"], "seconds": secs}
        finally:
            shutil.rmtree(work, ignore_errors=True)


def _wav_seconds(path: Path):
    try:
        import wave
        with wave.open(str(path), "rb") as w:
            return round(w.getnframes() / float(w.getframerate()), 2)
    except Exception:  # noqa: BLE001 - not every WAV header is standard
        return None
