"""The Tiiny's tools for AI assistants (MCP, see mcp.py): what an app with the "mcp" scope can ask the Tiiny to do.

Each tool says what it does, the arguments it takes (a JSON Schema) and which scope it needs; an app only sees and
uses the tools its scopes allow. A tool picks its model by kind (one that's loaded first, else the smallest), makes
sure it's loaded following the app's loading policy, borrowing what it had to load (npu.use), and notes the work as
the app's, so the dashboard's Right now names it.

Files come and go as base64. Over stdio, the bridge turns file paths into base64 itself (mcp.py): this panel never
opens a path an app names.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
import struct
import tempfile
import urllib.parse

from . import activity, decide, device, gateway, npu
from .common import BORROWED, BadRequest, DeviceError, error_message, safe_name

MAX_INPUT = 50 * 1024 ** 2   # decoded bytes of one file argument
EDIT_FAMILIES = re.compile(r"flux|hidream|sensenova|qwen_image|qwen-image", re.I)   # image models that can edit (static/app.js)
SINGLE_PURPOSE = ("background-remove", "object-remove", "outpaint")                # image add-ons made for one job only
DESIGN_VOICE = "A calm, warm voice, speaking clearly at a relaxed pace."
CACHE_TTL_MS = 300000


class ToolError(Exception):
    """A tool couldn't do it: the message goes back to the assistant as the tool's answer (isError)."""


def text(s) -> dict:
    return {"type": "text", "text": str(s)}


def short(mid) -> str:
    return str(mid or "").split("/")[-1]


def b64decode(value, what: str) -> bytes:
    """A file argument: plain base64 or a data: URL."""
    if not isinstance(value, str) or not value.strip():
        raise ToolError(f"Send the {what} as base64 (or as a data: URL).")
    v = value.strip()
    if v.startswith("data:"):
        v = v.split(",", 1)[-1]
    if len(v) > MAX_INPUT * 4 // 3 + 16:
        raise ToolError(f"That {what} is too large (50 MB at most).")
    try:
        return base64.b64decode(v + "=" * (-len(v) % 4), validate=False)
    except (binascii.Error, ValueError):
        raise ToolError(f"The {what} isn't valid base64.")


def image_mime(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return ""


def image_size(data: bytes):
    """(width, height) from a PNG, JPEG, GIF or WebP header, without decoding the picture; None if unknown."""
    try:
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return struct.unpack(">II", data[16:24])
        if data[:6] in (b"GIF87a", b"GIF89a"):
            return struct.unpack("<HH", data[6:10])
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            if data[12:16] == b"VP8X":
                return 1 + int.from_bytes(data[24:27], "little"), 1 + int.from_bytes(data[27:30], "little")
            if data[12:16] == b"VP8 ":
                w, h = struct.unpack("<HH", data[26:30])
                return w & 0x3FFF, h & 0x3FFF
        if data[:3] == b"\xff\xd8\xff":
            i = 2
            while i + 9 < len(data):
                if data[i] != 0xFF:
                    i += 1
                    continue
                marker = data[i + 1]
                length = struct.unpack(">H", data[i + 2:i + 4])[0]
                if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                    h, w = struct.unpack(">HH", data[i + 5:i + 9])
                    return w, h
                i += 2 + length
    except (struct.error, IndexError):
        return None
    return None


def edit_size(w: int, h: int) -> tuple:
    """The size an edit is made at: the long side between 512 and 1024, multiples of 16 (agent.js: editSize)."""
    long = min(max(max(w, h), 512), 1024)
    k = long / max(w, h)
    return max(256, round(w * k / 16) * 16), max(256, round(h * k / 16) * 16)


def tts_mode(m: dict) -> str:
    """How a voice model is asked to speak: "design" (a description), "clone" (a recording) or "builtin" (a voice name)."""
    names = f"{m.get('id', '')} {m.get('display_name') or ''} {m.get('name') or ''}"
    if re.search(r"voice-?design", names, re.I):
        return "design"
    if re.search(r"voice-?clone|tts\S*[-_]base\b", names, re.I):
        return "clone"
    return "builtin"


def image_from(data: bytes, ctype: str) -> bytes:
    """The picture in a device answer: the bytes themselves, or base64 in JSON ({"data": [{"b64_json": …}]} and similar)."""
    if ctype.startswith("image/") or image_mime(data):
        return data
    try:
        j = json.loads(data)
    except ValueError:
        raise ToolError("No picture came back.")
    item = (j.get("data") or [{}])[0] if isinstance(j.get("data"), list) else j
    b = item.get("b64_json") or item.get("image") or item.get("b64")
    if not b:
        raise ToolError("No picture came back.")
    return b64decode(b, "picture")


def hits(data, limit: int) -> list:
    """Vault passages from /kb/retrieve, whatever shape the answer takes (static/app.js: normalizeHits)."""
    arr = data if isinstance(data, list) else None
    if arr is None and isinstance(data, dict):
        for k in ("results", "chunks", "items", "hits", "documents", "matches", "contexts"):
            if isinstance(data.get(k), list):
                arr = data[k]
                break
        if arr is None:
            arr = next((v for v in data.values() if isinstance(v, list)), [])
    out = []
    for x in arr or []:
        if isinstance(x, str):
            out.append({"text": x, "source": "", "score": None})
            continue
        if not isinstance(x, dict):
            continue
        meta = x.get("metadata") if isinstance(x.get("metadata"), dict) else {}
        t = next((x[k] for k in ("lossless_restatement", "text", "content", "chunk", "chunk_text", "document", "page_content", "preview", "snippet")
                  if isinstance(x.get(k), str) and x[k].strip()), None) or json.dumps(x)[:2000]
        t = re.sub(r"\\([\\`*_{}\[\]()#+\-.!|>~])", r"\1", re.sub(r"^Source file:[^\n]*\n+", "", t)).strip()
        src = next((x[k] for k in ("filename", "file_name", "source_name", "title", "source", "name") if isinstance(x.get(k), str) and x[k]), None) \
            or next((meta[k] for k in ("filename", "source", "title") if isinstance(meta.get(k), str) and meta[k]), "") or str(x.get("source_id") or "")
        semantic = next((r for r in x.get("recalls") or [] if isinstance(r, dict) and r.get("arm") == "semantic"), None)
        score = next((v for v in ((semantic or {}).get("score"), x.get("score"), x.get("similarity"), x.get("relevance"), x.get("relevance_score"))
                      if isinstance(v, (int, float)) and not isinstance(v, bool)), None)
        out.append({"text": t, "source": src, "score": score if isinstance(score, (int, float)) else None})
    return out[:limit]


class Tool:
    def __init__(self, name, title, description, schema, scope=None, read_only=True, run=None):
        self.name, self.title, self.description, self.schema, self.scope, self.read_only, self.run = \
            name, title, description, schema, scope, read_only, run

    def spec(self) -> dict:
        return {"name": self.name, "title": self.title, "description": self.description, "inputSchema": self.schema,
                "annotations": {"title": self.title, "readOnlyHint": self.read_only, "destructiveHint": False,
                                "idempotentHint": self.read_only, "openWorldHint": False}}


def obj(props: dict, required=()) -> dict:
    return {"type": "object", "properties": props, "required": list(required), "additionalProperties": False}


MODEL_ARG = {"type": "string", "description": "Optional: a model on the Tiiny (its id or short name). Leave it out to use a loaded one, else the smallest that fits."}


class Toolbox:
    """The tools, and what they need from the panel."""

    def __init__(self, devconn, settings, gallery=None, runtime=None):
        self.devconn, self.settings, self.gallery, self.rt = devconn, settings, gallery, runtime
        self.tools = [
            Tool("tiiny_ask", "Ask a model on the Tiiny",
                 "Ask a language model that runs on the user's Tiiny, a small AI computer on their desk. Nothing leaves their own "
                 "hardware, so it suits private text (contracts, health, personal notes). Returns the model's answer.",
                 obj({"prompt": {"type": "string", "description": "The question or task, with any text it needs."},
                      "system": {"type": "string", "description": "Optional instructions for the model."},
                      "model": MODEL_ARG,
                      "max_tokens": {"type": "integer", "minimum": 1, "maximum": 8192, "description": "Longest answer, in tokens (default 1024)."},
                      "thinking": {"type": "boolean", "description": "Let models that can think do so first (slower, sometimes better). Default false."}},
                     ["prompt"]), "chat", run=self.ask),
            Tool("tiiny_generate_image", "Make a picture",
                 "Make a picture from a description with an image model on the Tiiny. Returns the picture, which is also saved in "
                 "the Tiiny Control Panel's Gallery. Takes from a few seconds to a few minutes.",
                 obj({"prompt": {"type": "string", "description": "What the picture should show."},
                      "width": {"type": "integer", "minimum": 256, "maximum": 1536, "description": "Default 1024."},
                      "height": {"type": "integer", "minimum": 256, "maximum": 1536, "description": "Default 1024."},
                      "model": MODEL_ARG}, ["prompt"]), "images", read_only=False, run=self.generate_image),
            Tool("tiiny_edit_image", "Edit a picture",
                 "Change a picture with an image model on the Tiiny, for example “make it night time”. Returns the new picture, also "
                 "saved in the Gallery.",
                 obj({"image": {"type": "string", "description": "The picture (PNG or JPEG) as base64 or a data: URL."},
                      "instruction": {"type": "string", "description": "What to change."},
                      "model": MODEL_ARG}, ["image", "instruction"]), "images", read_only=False, run=self.edit_image),
            Tool("tiiny_transcribe", "Write down a recording",
                 "Turn speech in a recording into text with a speech recognition model on the Tiiny (for example Whisper).",
                 obj({"audio": {"type": "string", "description": "The recording (WAV, MP3, M4A, …) as base64."},
                      "filename": {"type": "string", "description": "Its file name, so the format is clear (default audio.wav)."},
                      "language": {"type": "string", "description": "Optional language code, for example en or de."},
                      "model": MODEL_ARG}, ["audio"]), "audio", run=self.transcribe),
            Tool("tiiny_speak", "Read text aloud",
                 "Turn text into speech with a voice model on the Tiiny. Returns the audio.",
                 obj({"text": {"type": "string", "description": "What to say."},
                      "instructions": {"type": "string", "description": "For voice-design models: how the voice sounds, e.g. “a calm, warm narrator”."},
                      "voice": {"type": "string", "description": "For models with built-in voices: the voice's name."},
                      "format": {"type": "string", "enum": ["mp3", "wav"], "description": "Default mp3."},
                      "model": MODEL_ARG}, ["text"]), "audio", run=self.speak),
            Tool("tiiny_ocr", "Read text in a picture",
                 "Read the text in a picture (a scan, a screenshot, a photo of a page) with an OCR model on the Tiiny.",
                 obj({"image": {"type": "string", "description": "The picture as base64 or a data: URL."}, "model": MODEL_ARG}, ["image"]),
                 "ocr", run=self.ocr),
            Tool("tiiny_search_vault", "Search the Vault",
                 "Search the user's Vault, the documents they keep on their Tiiny. Returns the passages that fit best, with their sources.",
                 obj({"question": {"type": "string", "description": "What to look for, in plain words."},
                      "limit": {"type": "integer", "minimum": 1, "maximum": 20, "description": "How many passages (default 6)."}}, ["question"]),
                 "vault_read", run=self.search_vault),
            Tool("tiiny_save_to_vault", "Save to the Vault",
                 "Save a document into the user's Vault on their Tiiny, where it's indexed so it can be searched later.",
                 obj({"name": {"type": "string", "description": "A file name, for example meeting-notes.md."},
                      "text": {"type": "string", "description": "The document's text (or send data instead)."},
                      "data": {"type": "string", "description": "The file's bytes as base64, for files that aren't plain text."}}, ["name"]),
                 "vault_write", read_only=False, run=self.save_to_vault),
            Tool("tiiny_decide", "Ask a decision model",
                 "Ask a decision model on the Tiiny typed questions about a text: yes/no (“noul”), one of several options (“choice”) "
                 "or a level on a scale (“score”). It answers with a probability for each option, in a fraction of a second.",
                 obj({"state": {"type": "string", "description": "The text the questions are about."},
                      "questions": {"type": "object", "description": "Up to 64 named questions, e.g. {\"angry\": {\"type\": \"noul\", \"instructions\": "
                                    "\"Is the customer upset?\"}, \"team\": {\"type\": \"choice\", \"instructions\": \"Which team?\", \"criteria\": "
                                    "{\"billing\": \"payments\", \"other\": \"anything else\"}}}"}}, ["state", "questions"]),
                 "decisions", run=self.decide),
            Tool("tiiny_device_status", "Tiiny status",
                 "What the user's Tiiny is doing: the loaded models, how full its NPU memory is, and what's running now.",
                 obj({}), None, run=self.device_status),
            Tool("tiiny_list_models", "Models on the Tiiny",
                 "The models on the user's Tiiny that this app may use, with their kind, size in NPU memory and whether they're loaded.",
                 obj({"kind": {"type": "string", "enum": sorted(gateway.KINDS), "description": "Only models of this kind."}}),
                 None, run=self.list_models),
        ]
        self.by_name = {t.name: t for t in self.tools}

    # -- for mcp.py -------------------------------------------------------------------------------------------
    def allowed(self, app) -> list:
        return [t for t in self.tools if t.scope is None or t.scope in app["scopes"]]

    def call(self, app, name: str, args: dict) -> dict:
        """Run a tool. Returns an MCP tool result; a tool that couldn't do it answers with isError."""
        tool = self.by_name[name]
        try:
            content, structured = tool.run(app, args or {})
            out = {"content": content, "isError": False}
            if structured is not None:
                out["structuredContent"] = structured
            return out
        except (ToolError, npu.NotReady, gateway.Refused, BadRequest, decide.Unavailable) as e:
            return {"content": [text(getattr(e, "message", None) or str(e))], "isError": True}
        except DeviceError as e:
            return {"content": [text(f"Your Tiiny didn't answer: {e}")], "isError": True}

    # -- helpers ----------------------------------------------------------------------------------------------
    def _info(self):
        return self.devconn.resolve()

    def _use(self, app, model):
        return npu.use(model, policy=app.get("policy") or "fits", requester=app["name"], unload_after=app.get("unload_after"), why=app["name"])

    def _track(self, app, path, model, tool):
        return activity.track(path, model, title=f"{app['name']} · {tool}")

    def _post(self, info, path, body: dict, timeout=900) -> tuple:
        """POST JSON to the device; returns (bytes, content type). Raises ToolError with the device's message."""
        conn, resp = device.device_open(info, "core", "POST", path, body=json.dumps(body).encode(),
                                        headers={"Content-Type": "application/json", "Accept": "*/*"}, timeout=timeout)
        try:
            data = resp.read(200 * 1024 ** 2)
            ctype = resp.headers.get("Content-Type") or ""
        finally:
            conn.close()
        if not 200 <= resp.status < 300:
            try:
                j = json.loads(data)
            except ValueError:
                j = None
            raise ToolError(error_message(j, data.decode("utf-8", "replace"), resp.status))
        return data, ctype

    def _to_gallery(self, app, data: bytes, mime: str, meta: dict):
        if not self.gallery or not self.rt:
            return None
        ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}.get(mime, "png")
        path = self.rt.new_output_path(f"image.{ext}")
        with open(path, "wb") as f:
            f.write(data)
        try:
            rec = self.gallery.add_files("image", [(path, f"image.{ext}", "main")], dict(meta, source=f"app: {app['name']}"))
            return rec.get("id")
        except Exception:  # noqa: BLE001 - the picture itself still goes back to the app
            return None

    def _pick(self, kind, asked, app, info, ok=None) -> str:
        """The model for a tool: what the app asked for, else a loaded one of the kind, else the smallest (gateway.resolve)."""
        if asked or ok is None:
            return gateway.resolve(asked, kind, app, info)
        models = [m for m in npu.models(info) if gateway.kind_ok(m, kind) and ok(m) and not npu.DL_BUSY.match(str(m.get("status") or ""))]
        if not models:
            raise ToolError(f"There's no {gateway.kind_names(kind)} model on the Tiiny that can do this.")
        running = set(device.running_ids(info))
        loaded = [m for m in models if m["id"] in running]
        return (loaded or sorted(models, key=lambda m: float(m.get("npu_usage") or 999)))[0]["id"]

    def _meta(self, info, mid) -> dict:
        return next((m for m in npu.models(info) if m["id"] == mid), {"id": mid})

    # -- the tools --------------------------------------------------------------------------------------------
    def ask(self, app, a):
        prompt = str(a.get("prompt") or "").strip()
        if not prompt:
            raise ToolError("What should the model answer? Send it in “prompt”.")
        info = self._info()
        model = gateway.resolve(a.get("model"), "chat", app, info)
        messages = ([{"role": "system", "content": str(a["system"])}] if a.get("system") else []) + [{"role": "user", "content": prompt}]
        max_tokens = max(1, min(8192, int(a.get("max_tokens") or 1024)))
        with self._use(app, model), self._track(app, "/v1/chat/completions", model, "ask"):
            out = device.chat(info, model, messages, thinking=bool(a.get("thinking")), max_tokens=max_tokens, timeout=900)
        answer = (out.get("content") or "").strip()
        if not answer:
            answer = "(The model gave no answer; it may have used all its tokens thinking. Try a larger max_tokens, or thinking off.)"
        return [text(answer)], {"model": model, "answer": answer, "finish_reason": out.get("finish_reason")}

    def generate_image(self, app, a):
        prompt = str(a.get("prompt") or "").strip()
        if not prompt:
            raise ToolError("Describe the picture in “prompt”.")
        size = lambda v: min(1536, max(256, round(int(v or 1024) / 16) * 16))
        w, h = size(a.get("width")), size(a.get("height"))
        info = self._info()
        model = self._pick("image", a.get("model"), app, info, ok=lambda m: not any(s in m["id"].lower() for s in SINGLE_PURPOSE))
        with self._use(app, model), self._track(app, "/v1/images/generations", model, "picture"):
            data, ctype = self._post(info, "/v1/image/generate", {"model": model, "prompt": prompt, "width": w, "height": h})
        img = image_from(data, ctype)
        mime = image_mime(img) or "image/png"
        gid = self._to_gallery(app, img, mime, {"prompt": prompt, "model": model, "params": {"width": w, "height": h}})
        return ([{"type": "image", "data": base64.b64encode(img).decode(), "mimeType": mime},
                 text(f"Made a {w}×{h} picture with {short(model)}" + (", saved in the Gallery." if gid else "."))],
                {"model": model, "width": w, "height": h, "gallery_id": gid})

    def edit_image(self, app, a):
        instruction = str(a.get("instruction") or "").strip()
        if not instruction:
            raise ToolError("Say what to change in “instruction”.")
        src = b64decode(a.get("image"), "picture")
        mime = image_mime(src)
        if mime not in ("image/png", "image/jpeg", "image/webp"):
            raise ToolError("Send the picture as a PNG, JPEG or WebP.")
        dims = image_size(src)
        if not dims or not all(dims):
            raise ToolError("Couldn't read the picture's size.")
        w, h = edit_size(*dims)
        info = self._info()
        model = self._pick("image", a.get("model"), app, info,
                           ok=lambda m: EDIT_FAMILIES.search(m["id"]) and not any(s in m["id"].lower() for s in SINGLE_PURPOSE))
        data_url = f"data:{mime};base64,{base64.b64encode(src).decode()}"
        with self._use(app, model), self._track(app, "/v1/images/generations", model, "edit"):
            data, ctype = self._post(info, "/v1/image/generate", {"model": model, "prompt": instruction, "width": w, "height": h,
                                                                  "steps": 20, "image": data_url})
        img = image_from(data, ctype)
        out_mime = image_mime(img) or "image/png"
        gid = self._to_gallery(app, img, out_mime, {"prompt": instruction, "model": model, "params": {"width": w, "height": h, "steps": 20, "edit": True}})
        return ([{"type": "image", "data": base64.b64encode(img).decode(), "mimeType": out_mime},
                 text(f"Edited the picture with {short(model)} ({w}×{h})" + (", saved in the Gallery." if gid else "."))],
                {"model": model, "width": w, "height": h, "gallery_id": gid})

    def transcribe(self, app, a):
        audio = b64decode(a.get("audio"), "recording")
        name = safe_name(str(a.get("filename") or "audio.wav")) or "audio.wav"
        info = self._info()
        model = gateway.resolve(a.get("model"), "asr", app, info)
        fields = {"model": model}
        if a.get("language"):
            fields["language"] = str(a["language"])[:20]
        work = getattr(self.rt, "work", None)
        d = tempfile.mkdtemp(dir=str(work) if work else None)
        path = os.path.join(d, name)
        try:
            with open(path, "wb") as f:
                f.write(audio)
            with self._use(app, model), self._track(app, "/v1/audio/transcriptions", model, "transcribe"):
                out = device.post_multipart(info, "core", "/v1/audio/transcriptions", fields, [("file", path, name)], timeout=1800)
        finally:
            try:
                os.remove(path)
                os.rmdir(d)
            except OSError:
                pass
        said = (out.get("text") or out.get("transcript") or "").strip() if isinstance(out, dict) else str(out or "")
        return [text(said or "(No speech was heard.)")], {"model": model, "text": said}

    def speak(self, app, a):
        words = str(a.get("text") or "").strip()
        if not words:
            raise ToolError("What should be said? Send it in “text”.")
        fmt = a.get("format") if a.get("format") in ("mp3", "wav") else "mp3"
        info = self._info()
        model = self._pick("tts", a.get("model"), app, info, ok=lambda m: tts_mode(m) != "clone")
        meta = self._meta(info, model)
        mode = tts_mode(meta)
        if mode == "clone":
            raise ToolError(f"{short(model)} copies a voice from a recording, which this tool doesn't take. Use a voice-design model or one with built-in voices.")
        body = {"model": model, "input": words, "response_format": fmt}
        if mode == "design":
            body["instructions"] = str(a.get("instructions") or DESIGN_VOICE)
        elif a.get("voice"):
            body["voice"] = str(a["voice"])
        with self._use(app, model), self._track(app, "/v1/audio/speech", model, "speak"):
            data, ctype = self._post(info, "/v1/audio/speech", body)
        mime = ctype.split(";")[0].strip() if ctype.startswith("audio/") else ("audio/wav" if fmt == "wav" else "audio/mpeg")
        return ([{"type": "audio", "data": base64.b64encode(data).decode(), "mimeType": mime},
                 text(f"Spoken by {short(model)} ({len(data) // 1024} KB of {mime}).")], {"model": model, "bytes": len(data), "mimeType": mime})

    def ocr(self, app, a):
        img = b64decode(a.get("image"), "picture")
        mime = image_mime(img) or "image/png"
        info = self._info()
        model = gateway.resolve(a.get("model"), "ocr", app, info)
        with self._use(app, model):
            data, ctype = self._post(info, "/v1/ocr?" + urllib.parse.urlencode({"model": model}),
                                     {"input": f"data:{mime};base64,{base64.b64encode(img).decode()}", "response_format": "json"})
        try:
            j = json.loads(data)
        except ValueError:
            j = data.decode("utf-8", "replace")
        found = j if isinstance(j, str) else next((j[k] for k in ("text", "content", "result", "markdown") if isinstance(j, dict) and isinstance(j.get(k), str)), None)
        if found is None:
            found = json.dumps(j, ensure_ascii=False)[:20000]
        return [text(found.strip() or "(No text found.)")], {"model": model, "text": found}

    def search_vault(self, app, a):
        q = str(a.get("question") or "").strip()
        if not q:
            raise ToolError("What should be looked for? Send it in “question”.")
        limit = max(1, min(20, int(a.get("limit") or 6)))
        info = self._info()
        status, data, raw = device.call(info, "kb", "POST", "/kb/retrieve", body={"question": q}, timeout=120)
        if not 200 <= status < 300:
            raise ToolError(f"The Vault didn't answer: {error_message(data, raw, status)}")
        found = hits(data, limit)
        if not found:
            return [text("Nothing in the Vault fits that question.")], {"passages": []}
        lines = [f"[{i}] {h['text']}" + (f"\n(source: {h['source']})" if h["source"] else "") for i, h in enumerate(found, 1)]
        return [text("\n\n".join(lines))], {"passages": found}

    def save_to_vault(self, app, a):
        name = safe_name(str(a.get("name") or ""))
        if not name:
            raise ToolError("Give the document a file name in “name”, for example notes.md.")
        if a.get("data"):
            data = b64decode(a["data"], "file")
        elif isinstance(a.get("text"), str) and a["text"].strip():
            data = a["text"].encode("utf-8")
        else:
            raise ToolError("Send the document in “text”, or its bytes as base64 in “data”.")
        if len(data) > MAX_INPUT:
            raise ToolError("That file is too large (50 MB at most).")
        info = self._info()
        work = getattr(self.rt, "work", None) or tempfile.gettempdir()
        out = device.vault_upload(info, work, name, data, finalize=True)
        return ([text(f"Saved {out.get('filename') or name} in the Vault" + (" and indexed it." if out.get("indexed") else "; it's being indexed."))],
                {"source_id": out.get("source_id"), "filename": out.get("filename") or name, "indexed": out.get("indexed")})

    def decide(self, app, a):
        questions = a.get("questions")
        try:
            decide.check_questions(questions)
        except ValueError as e:
            raise ToolError(str(e))
        info = self._info()
        try:
            model = decide.choose(info, self.settings)[0]["id"]   # the panel's chosen decision model, else a loaded one, else the smallest
            with self._use(app, model), self._track(app, "/v1/systemone", model, "decide"):
                out = decide.ask(info, model, a.get("state"), questions)
        except ValueError as e:
            raise ToolError(str(e))
        answers = out.get("answers", out) if isinstance(out, dict) else out
        return [text(json.dumps(answers, ensure_ascii=False, indent=1))], {"model": model, "answers": answers}

    def device_status(self, app, a):
        info = self._info()
        st = npu.state(info)
        models = {m["id"]: m for m in npu.models(info)}
        total = st["total_mb"] or npu.CARD_MB
        loaded = [{"id": mid, "type": models.get(mid, {}).get("type"), "npu_mb": round(npu.share(models.get(mid, {"id": mid}), total)["mb"]),
                   "busy": mid in st["busy"], "loaded_for": (BORROWED.snapshot().get(mid) or {}).get("why")} for mid in sorted(st["ready"])]
        used = st["used_mb"]
        lines = [f"NPU memory: {used / 1024:.1f} of {total / 1024:.1f} GB in use." if used is not None else "NPU memory: nothing loaded."]
        lines += [f"- {short(m['id'])} ({m['type']}, about {m['npu_mb'] / 1024:.1f} GB){' · working' if m['busy'] else ''}"
                  f"{' · loaded for ' + m['loaded_for'] + ' (unloaded again later)' if m['loaded_for'] else ''}" for m in loaded] or ["No models are loaded."]
        if st["pending"]:
            lines.append("Loading now: " + ", ".join(short(x) for x in sorted(st["pending"])))
        return [text("\n".join(lines))], {"loaded": loaded, "loading": sorted(st["pending"]), "npu_used_mb": used, "npu_total_mb": total}

    def list_models(self, app, a):
        info = self._info()
        kind = a.get("kind") if a.get("kind") in gateway.KINDS else None
        running = set(device.running_ids(info))
        out = []
        for m in npu.models(info):
            if npu.DL_BUSY.match(str(m.get("status") or "")) or not gateway.usable(app, m):
                continue
            kinds = [k for k in gateway.KINDS if gateway.kind_ok(m, k)]
            if kind and kind not in kinds:
                continue
            out.append({"id": m["id"], "type": m.get("type"), "kinds": kinds, "loaded": m["id"] in running,
                        "npu_percent": m.get("npu_usage") or None, "params": m.get("params") or None, "context_window": m.get("context_window")})
        out.sort(key=lambda x: (not x["loaded"], x["id"].lower()))
        lines = [f"- {x['id']} ({x['type']}{', loaded' if x['loaded'] else ''}{', ~' + str(x['npu_percent']) + '% of NPU memory' if x['npu_percent'] else ''})" for x in out]
        return [text("\n".join(lines) or "No models this app may use.")], {"models": out}
