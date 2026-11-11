"""Chat replies written by the panel server: a reply carries on when you close the tab or lock your phone.

A reply ("turn") is a background job (kind "chat-turn", one per chat). It gathers the context as the page did in 1.2.0
(the chat's instructions, project and pinned files, your profile, the Vault, the tools a decision model picks, Auto
thinking), streams the model's answer from the Tiiny and, in agent mode, runs the agent's tools (agenttools.py) for up to
agenttools.MAX_STEPS rounds. A step that needs your approval waits until you answer, from the computer or a phone;
commands, file changes and opening things on the computer can only be approved on the computer.

The reply is saved in the chat as it grows (every SAVE_EVERY seconds while text streams, after each step and at the end),
in the shape the page used, so old chats look the same. While a turn runs it's the only writer of the chat's messages.
Every write of the messages counts up the chat's "rev"; a page saving a chat with an older rev keeps the server's messages
(merge_put), so a tab that missed a reply can't overwrite it.

Pages follow a turn over /api/turns/{id}/stream: a snapshot of the reply, then numbered events ("delta": text added,
"set": fields replaced, "step": an agent step added or changed, "done": the finished reply). A page that reconnects asks
for the events after the last number it saw.
"""

from __future__ import annotations

import json
import re
import threading
import time
import traceback
import urllib.parse

from . import activity, agenttools as at, commands, decide, device, jobs as jobmod, npu
from .common import BORROWED, USAGE, BadRequest, DeviceError, new_id
from .jobs import Cancelled

SAVE_EVERY = 3.0          # seconds between saves while text streams (steps and the end save at once)
DELTA_EVERY = 0.05        # seconds of text collected into one "delta" event
APPROVAL_WAIT = 24 * 3600  # an approval nobody answers is declined after this long
WAITING_NOTE_AFTER = 1.5   # seconds without an answer before a reply says what it waits for
KEEP_FINISHED = 600       # seconds a finished turn stays available to pages that come late
COMPUTER_RISKS = ("command", "file", "open", "computer")   # approved only on the computer the panel runs on


# -- the page's chat helpers, ported (static/app.js, static/js/chat.js, static/js/agent.js) ---------------------------
def split_thinking(m: dict) -> tuple:
    """(reasoning, answer): <think>…</think> in the content moves to the reasoning (app.js: splitThinking)."""
    reasoning, answer = m.get("reasoning") or "", m.get("content") or ""
    start = answer.find("<think>")
    if start != -1:
        end = answer.find("</think>", start)
        if end == -1:
            reasoning += answer[start + 7:]
            answer = answer[:start]
        else:
            reasoning += answer[start + 7:end]
            answer = answer[:start] + answer[end + 8:]
    elif "</think>" in answer:
        end = answer.find("</think>")
        reasoning += answer[:end]
        answer = answer[end + 8:]
    return reasoning.strip(), answer.lstrip()


def build_messages(chat: dict, upto, system: str) -> list:
    """The conversation for the model: the system text, then up to 40 earlier messages (chat.js: buildMessages)."""
    out = [{"role": "system", "content": system}] if system else []
    history = []
    for m in chat.get("messages") or []:
        if m is upto:
            break
        if m.get("role") == "user":
            images = m.get("images") or []
            text = "\n\n".join(x for x in (m.get("docText"), m.get("content")) if x) or ("Describe this image." if images else "")
            if images:
                history.append({"role": "user", "content": [{"type": "text", "text": text}] + [{"type": "image_url", "image_url": {"url": u}} for u in images]})
            else:
                history.append({"role": "user", "content": text + ("\n\n[An image was attached here earlier but is no longer available.]" if m.get("imagesDropped") else "")})
        elif m.get("role") == "assistant" and m.get("content") and not m.get("error"):
            history.append({"role": "assistant", "content": split_thinking(m)[1]})
    return out + history[-40:]


def recent_text(chat: dict, upto, n: int = 4) -> str:
    """The last few messages before `upto`, for a decision model (agent.js: recentText)."""
    msgs = chat.get("messages") or []
    at_ = next((i for i, m in enumerate(msgs) if m is upto), None)
    msgs = [m for m in (msgs[:at_] if at_ is not None else msgs) if m.get("role") in ("user", "assistant")][-n:]
    lines = []
    for m in msgs:
        if m["role"] == "assistant":
            text = split_thinking(m)[1]
        else:
            text = " ".join(x for x in [m.get("content")] + [f"(attached {d.get('name')})" for d in m.get("docs") or []] if x)
        lines.append(f"{'User' if m['role'] == 'user' else 'Assistant'}: {str(text)[:1500]}")
    return "\n\n".join(lines)


def parse_tool_args(raw) -> dict:
    if isinstance(raw, dict):
        return raw
    try:
        v = json.loads(raw or "{}")
        return v if isinstance(v, dict) else {}
    except (ValueError, TypeError):
        m = re.search(r"\{[\s\S]*\}", str(raw or ""))
        if m:
            try:
                v = json.loads(m.group(0))
                return v if isinstance(v, dict) else {}
            except ValueError:
                pass
        return {}


INLINE_CALL = re.compile(r"<tool_call>\s*([\s\S]*?)\s*</tool_call>")


def extract_inline_tool_calls(content: str) -> tuple:
    """Some model servers answer with Qwen-style <tool_call>{...}</tool_call> text instead of structured calls."""
    calls = []

    def take(m):
        try:
            j = json.loads(m.group(1))
        except ValueError:
            return ""
        if isinstance(j, dict) and j.get("name"):
            args = j.get("arguments")
            calls.append({"id": f"call_{new_id('')}", "name": j["name"], "arguments": args if isinstance(args, str) else json.dumps(args or {})})
        return ""
    return calls, INLINE_CALL.sub(take, str(content or ""))


def add_usage(a, b):
    if not b:
        return a
    if not a:
        return dict(b)
    return {k: (a.get(k) or 0) + (b.get(k) or 0) for k in ("prompt_tokens", "completion_tokens", "total_tokens")}


def thinking_options(chat: dict, meta: dict, auto_ok: bool):
    """How the model thinks for this reply (chat.js: thinkingOptions): None when it can't."""
    t = (meta or {}).get("thinking")
    if not isinstance(t, dict) or not t.get("supported"):
        return None
    levels = [x for x in t.get("levels") or [] if isinstance(x, str)]
    default_on = True if t.get("enabled_by_default") is None else bool(t.get("enabled_by_default"))
    auto = bool(t.get("toggleable")) and chat.get("thinking") == "auto" and auto_ok
    if t.get("toggleable"):
        enabled = default_on if auto else (chat["thinking"] if isinstance(chat.get("thinking"), bool) else default_on)
    else:
        enabled = True
    level = (chat.get("depth") if chat.get("depth") in levels else (t.get("default_level") or levels[0])) if levels else None
    return {"toggleable": bool(t.get("toggleable")), "enabled": enabled, "levels": levels, "level": level, "auto": auto}


def _copy(v):
    return json.loads(json.dumps(v, ensure_ascii=False))


class TurnError(Exception):
    """The reply can't be written; the message is shown under it."""


# -- one reply ----------------------------------------------------------------------------------------------------------
class Turn:
    def __init__(self, mgr, chat: dict, *, remote=False, unattended=False, allowed=None, instructions="", why=""):
        self.mgr, self.env = mgr, mgr.env
        self.chat, self.chat_id = chat, chat["id"]
        self.remote, self.unattended, self.allowed, self.instructions, self.why = bool(remote), bool(unattended), allowed, instructions, why
        self.lock = threading.RLock()
        self.job = self.thread = None
        model = chat.get("model") or "default"
        self.asst = {"role": "assistant", "content": "", "reasoning": "", "pending": True, "status": "",
                     "meta": {"model": model, "sources": []}, "notes": [], "steps": []}
        chat.setdefault("messages", []).append(self.asst)
        self.waiting = {}          # step index -> {"event", "decision"}
        self.allowed_now = {}      # tools allowed with "Always in this chat" during this turn
        self.rev = chat.get("rev") or 0
        self.dirty, self.last_save, self.gone = False, 0.0, False
        self._buf, self._buf_at = ["", ""], 0.0
        self.t_first = None
        self.session = new_id("t")
        self.borrowed = []         # models this turn borrowed (unattended): given back at the end
        self._waiting_said = False  # the reply says it's waiting for another request on its model (_say_waiting)
        self._waiting_for, self._waiting_model, self._stream_started = "", "", None
        self.finished_at = None

    # -- the reply, changed under the lock, each change an event for the pages that follow it ----------------------
    def _emit(self, kind, data):
        self.dirty = True
        self.job.emit(kind, data)

    def flush(self):
        with self.lock:
            if self._buf[0] or self._buf[1]:
                c, r = self._buf
                self._buf = ["", ""]
                self._emit("delta", {"c": c, "r": r})
            self._buf_at = time.time()

    def delta(self, c: str, r: str):
        with self.lock:
            self.asst["content"] += c
            self.asst["reasoning"] += r
            self._buf[0] += c
            self._buf[1] += r
            if time.time() - self._buf_at >= DELTA_EVERY:
                self.flush()

    def set(self, **fields):
        with self.lock:
            self.flush()
            self.asst.update(fields)
            self._emit("set", _copy(fields))

    def status(self, text: str):
        self.set(status=text)
        if self.job is not None:
            self.job.update(message=text)

    def note(self, text: str):
        with self.lock:
            self.asst["notes"].append(str(text))
            self.set(notes=list(self.asst["notes"]))

    def meta(self, **fields):
        with self.lock:
            self.asst["meta"].update(fields)
            self.set(meta=self.asst["meta"])

    def add_source(self, s: dict) -> dict:
        with self.lock:
            src = dict(s, n=len(self.asst["meta"]["sources"]) + 1)
            self.asst["meta"]["sources"].append(src)
            self.dirty = True
            return src

    def add_step(self, st: dict) -> int:
        with self.lock:
            self.flush()
            self.asst["steps"].append(st)
            i = len(self.asst["steps"]) - 1
            self._emit("step", {"i": i, "step": _copy(st)})
            return i

    def step(self, i: int, **changes):
        with self.lock:
            self.flush()
            st = self.asst["steps"][i]
            for k, v in changes.items():
                if v is None:
                    st.pop(k, None)
                else:
                    st[k] = v
            self._emit("step", {"i": i, "step": _copy(st)})

    def snapshot(self) -> tuple:
        """(the number of the last event it includes, the reply as it is now)."""
        with self.lock:
            self.flush()
            return self.job.event_n, _copy(self.asst)

    # -- saving ------------------------------------------------------------------------------------------------------
    def save(self, force=False):
        if threading.current_thread() is not self.thread and not force:
            return   # only the turn's own thread writes, so saves never go out of order
        with self.lock:
            if self.gone or (not force and (not self.dirty or time.time() - self.last_save < SAVE_EVERY)):
                return
            self.flush()
            msgs = _copy(self.chat["messages"])
            allow = dict(self.allowed_now)
            self.dirty, self.last_save = False, time.time()

        def apply(r):
            r["messages"] = msgs
            if allow:
                r["agentAllow"] = dict(r.get("agentAllow") or {}, **allow)
            r["rev"] = (r.get("rev") or 0) + 1
            self.rev = r["rev"]
        try:
            self.env.store.update("chats", self.chat_id, apply)
        except BadRequest:   # the chat was deleted: stop writing it
            self.gone = True
            self.job.cancel_event.set()

    def maybe_save(self):
        self.save(force=False)

    # -- running -------------------------------------------------------------------------------------------------------
    def run(self, job):
        self.job, self.thread = job, threading.current_thread()
        t0 = time.time()
        model = self.asst["meta"]["model"]
        try:
            self._reply()
        except Cancelled:
            self.meta(stopped=True)
        except (TurnError, DeviceError, BadRequest, at.ToolError, decide.Unavailable) as e:
            self.set(error=self._explain(e))
        except Exception as e:  # noqa: BLE001 - the reply says what went wrong instead of hanging
            traceback.print_exc()
            self.set(error=f"Something went wrong writing the reply: {e}")
        finally:
            t1 = time.time()
            with self.lock:
                self.flush()
                a = self.asst
                if not a["content"] and not a["reasoning"] and not a.get("error") and not a["meta"].get("stopped"):
                    a["error"] = "The model returned an empty reply."
                a["pending"], a["status"] = False, ""
                for st in a["steps"]:
                    if st.get("status") in ("approval", "running"):
                        st["status"] = "denied"
                    st.pop("progress", None)
                a["meta"]["ms"] = round((t1 - t0) * 1000)
                toks = (a["meta"].get("usage") or {}).get("completion_tokens")
                if toks and self.t_first and t1 > self.t_first:
                    a["meta"]["tps"] = toks / (t1 - self.t_first)
            self.save(force=True)
            with self.lock:
                self._emit("done", {"message": _copy(self.asst), "rev": self.rev})
            USAGE.touch(model)
            for mid in self.borrowed:
                BORROWED.give_back(mid, self.session, at.UNATTENDED_UNLOAD_AFTER)
            self.finished_at = time.time()
        return {"chat": self.chat_id, "error": self.asst.get("error") or None, "stopped": bool(self.asst["meta"].get("stopped"))}

    def info(self):
        if not hasattr(self, "_info"):
            self._info = self.env.devconn.resolve()
        return self._info

    def _models(self):
        return npu.models(self.info())

    def _decision_on(self, feature) -> bool:
        if feature in (self.env.settings.get("decisions_off") or []):
            return False
        return any(decide.is_decider(m) and not npu.DL_BUSY.match(str(m.get("status") or "")) for m in self._models())

    def _decision_loaded(self) -> bool:
        running = set(device.running_ids(self.info()))
        return any(decide.is_decider(m) and m["id"] in running for m in self._models())

    def _decide(self, feature, state, questions):
        """A decision for one of the reply's features, or None when it runs without one (app.js: decideFor)."""
        try:
            if self.unattended:   # nobody watching: a decision model it loads is given back afterwards
                m = decide.choose(self.info(), self.env.settings)[0]["id"]
                self._borrow(m)
            return decide.decide(self.env.devconn, self.env.settings, feature, state, questions, timeout=60)
        except (decide.Unavailable, ValueError, DeviceError):
            return None

    def _borrow(self, mid):
        if mid in self.borrowed:
            return
        loaded = mid in set(device.running_ids(self.info()))
        if BORROWED.borrow(mid, self.session, loaded=loaded, why=self.why or "a routine", after=at.UNATTENDED_UNLOAD_AFTER):
            self.borrowed.append(mid)

    def _ready(self, model):
        if self.unattended:   # a routine: it may unload only models loaded just for a moment, never yours
            self._borrow(model)
        npu.ensure_ready(model, policy="borrowed" if self.unattended else "fits", job=self.job, info=self.info())

    def _wait_index(self, pid):
        """Index a project's (or the chat's) files first when they need it (chat.js: waitForIndex)."""
        try:
            p = self.env.projects.get(pid)
        except BadRequest:
            return
        job = self.env.jobs.get((p.get("index_job") or {}).get("id")) if p.get("index_job") else None
        st = p.get("index_state") or {}
        if not job and st.get("needed") and st.get("stale", 0) > 0:
            try:
                job = self.env.projects.start_index(pid)
            except (BadRequest, DeviceError) as e:
                self.note(f"Couldn’t index the files: {e}")
                return
        if job and not job.finished:
            self.status("Indexing files so they can be searched…")
            version = -1
            while not job.finished:
                self.job.check()
                version = jobmod.JobManager.wait(job, version, 1)
                self.status(f"Indexing files… {job.message or ''}".rstrip())
            if job.status == "failed":
                self.note(f"Indexing failed: {job.error}")

    def _profile(self) -> str:
        try:
            status, data, _ = device.call(self.info(), "kb", "GET", "/kb/user-context", timeout=30)
        except DeviceError:
            return ""
        p = (data or {}).get("profile") if 200 <= status < 300 and isinstance(data, dict) else None
        p = p if isinstance(p, dict) else {}
        lines = [f"{label}: {p[k]}" for k, label in (("user_name", "Name"), ("occupation", "Occupation"), ("preferences", "Preferences"),
                                                     ("more_about_you", "More about them")) if p.get(k)]
        return "About the user (from their Tiiny profile):\n" + "\n".join(lines) if lines else ""

    def _pick_tools(self, ctx):
        """Which kinds of tools the message could need, by a decision model (agent.js: pickAgentTools)."""
        groups = at.groups_available(ctx)
        if len(groups) < 2:
            return None

        def ids(g):
            qs = at.GROUP_QUESTIONS[g]
            return [(g if i == 0 else f"{g}_{i}", q) for i, q in enumerate(qs if isinstance(qs, list) else [qs])]
        r = self._decide("agent_tools", recent_text(self.chat, self.asst),
                         {qid: {"type": "noul", "instructions": q} for g in groups for qid, q in ids(g)})
        if not r:
            return None

        def likely(qid):
            y = (r["answers"].get(qid) or {}).get("yes")
            return (1 if y is None else y) >= 0.2
        keep = {"helpers"} | {g for g in groups if any(likely(qid) for qid, _ in ids(g))}
        names = dict(at.GROUPS)
        chosen = [names.get(g, g) for g in groups if g in keep]
        who = at.short(r["model"])
        return {"keep": keep, "note": f"Tools offered for this message: {', '.join(chosen)} (chosen by {who})." if chosen
                else f"No tools needed for this message, {who} decided."}

    def _reply(self):
        env, chat, asst = self.env, self.chat, self.asst
        model = asst["meta"]["model"]
        self.save(force=True)
        if model != "default":
            if model not in set(device.running_ids(self.info())):
                self.status(f"Loading {at.short(model)} into NPU memory…")
            try:
                self._ready(model)
            except npu.NotReady as e:
                raise TurnError(str(e)) from None
        USAGE.touch(model)
        user = next((m for m in reversed(chat["messages"]) if m is not asst and m.get("role") == "user"), None) or {}
        question = user.get("content") or ", ".join(d.get("name", "") for d in user.get("docs") or []) or ""
        kids = [k for k in (chat.get("project_id"), chat.get("knowledge_id")) if k]
        ctx = at.Ctx(env, chat, job=self.job, remote=self.remote, unattended=self.unattended, sources=asst["meta"]["sources"],
                     knowledge_ids=kids, allowed=self.allowed)
        ctx.add_source, ctx.note = self.add_source, self.note
        parts = [chat["system"].strip()] if (chat.get("system") or "").strip() else []
        if self.instructions:
            parts.append(self.instructions)
        for pid in kids:
            self.status("Gathering the project’s context…" if pid == chat.get("project_id") else "Reading this chat’s files…")
            self._wait_index(pid)
            try:
                c = env.projects.context(pid, question, None, len(asst["meta"]["sources"]) + 1)
                if c.get("system"):
                    parts.append(c["system"])
                with self.lock:
                    asst["meta"]["sources"].extend(dict(s, project_id=pid) for s in c.get("sources") or [])
                if c.get("error"):
                    self.note(c["error"])
            except (BadRequest, DeviceError, OSError) as e:
                self.note(f"Couldn’t read the files: {e}")
        if chat.get("useProfile"):
            self.status("Reading your profile…")
            p = self._profile()
            if p:
                parts.append(p)
        if chat.get("useVault") and question:
            self.status("Searching your Vault…")
            hits = at.vault_search(ctx, question, 4)
            found = len(hits)
            if found and self._decision_on("vault_filter"):   # a decision model leaves out passages that don't fit
                self.status("Checking the passages…" if self._decision_loaded() else "Getting the decision model ready…")
                r = self._decide("vault_filter", f"Question: {question}\n\n" + "\n\n".join(
                    f"Passage {i + 1} ({x['source'] or 'Vault'}):\n{x['text']}" for i, x in enumerate(hits)),
                    {f"p{i + 1}": {"type": "noul", "instructions": f"Does passage {i + 1} contain information that helps answer the question?"}
                     for i in range(len(hits))})
                if r:
                    def fits(i):
                        y = (r["answers"].get(f"p{i + 1}") or {}).get("yes")
                        return (1 if y is None else y) >= 0.3
                    hits = [x for i, x in enumerate(hits) if fits(i)]
                    left = found - len(hits)
                    if hits and left:
                        self.note(f"Left out {left} Vault passage{'' if left == 1 else 's'} that didn’t fit the question ({at.short(r['model'])}).")
            if hits:
                lines = []
                for x in hits:
                    src = self.add_source({"name": x["source"] or "Vault", "kind": "vault", "text": x["text"], "score": x["score"]})
                    lines.append(f"[{src['n']}] {x['source'] or 'Vault'}:\n{x['text']}")
                parts.append("Relevant passages from the user’s Vault (cite them like [n] when you use them):\n\n" + "\n\n".join(lines))
            else:
                self.note("Your Vault had nothing related to this message." if found else "Your Vault had no passages related to this message.")
        if chat.get("agent") and self._decision_on("agent_tools"):
            self.status("Choosing tools…" if self._decision_loaded() else "Getting the decision model ready…")
            pick = self._pick_tools(ctx)
            if pick:
                ctx.tool_groups = pick["keep"]
                self.note(pick["note"])
        if chat.get("agent"):
            parts += self._agent_instructions(ctx)
        self.meta(sources=asst["meta"]["sources"])
        self.status("")
        body = {"model": model, "messages": build_messages(chat, asst, "\n\n".join(parts))}
        meta = next((m for m in self._models() if m["id"] == model), {})
        opts = thinking_options(chat, meta, self._decision_on("chat_thinking"))
        if opts and opts["auto"]:   # Auto: a decision model judges how much reasoning this message needs
            self.status("Deciding whether to think…" if self._decision_loaded() else "Getting the decision model ready…")
            r = self._decide("chat_thinking", recent_text(chat, asst, 3),
                             {"think": {"type": "score", "instructions": "How much careful, step-by-step reasoning does answering the user’s last message need?",
                                        "criteria": ["none", "a little", "a lot"]}})
            think = ((r or {}).get("answers") or {}).get("think") or {}
            v = think.get("value")
            # the expected level (0 none … 2 a lot) rather than the single likeliest one
            need = think.get("best") if v is None else ("none" if v < 0.5 else "a little" if v < 1.25 else "a lot")
            if need:
                opts["enabled"] = need != "none"
                opts["level"] = (opts["levels"][-1] if need == "a lot" else opts["levels"][0]) if opts["levels"] else None
                level = f" ({opts['level']})" if opts["level"] else ""
                state = f"on{level}" if opts["enabled"] else "off"
                self.note(f"Thinking: {state} (Auto, {at.short(r['model'])}).")
            self.status("")
        if opts:
            if opts["toggleable"]:
                body["thinking"] = opts["enabled"]
            if opts["enabled"] and opts["level"]:
                body["depth"] = opts["level"]
                if not opts["toggleable"]:
                    body["thinking"] = True
        if chat.get("agent"):
            res = self._agent(body, ctx)
        else:
            res = self._stream(body)
            self.meta(usage=res["usage"])
        self.meta(finish=res.get("finish"), **({"model": res["model"]} if res.get("model") else {}))
        if chat.get("project_id") and asst["content"] and not asst.get("error"):
            try:
                env.projects.start_memory_update(chat["project_id"], model, user.get("content") or "", split_thinking(asst)[1], self.chat_id)
            except (BadRequest, DeviceError):
                pass

    def _agent_instructions(self, ctx) -> list:
        st = self.env.settings

        def off(name):   # offered for this message (chat.js: offered)
            t = at.BY_NAME[name]
            return at.switched_on(t, st) and (ctx.tool_groups is None or t.group in ctx.tool_groups) and \
                (ctx.allowed is None or name in ctx.allowed or t.risk == "read" or t.always_ask)
        out = [" ".join(x for x in (
            "You can use tools. Use them when they help answer accurately, and don’t call tools you don’t need. Only write [n] citations "
            "for numbered passages that a search or read returned, never for calculations or other tool results.",
            "To find something on the web, call web_search first, then read the most useful results with fetch_web_page." if off("web_search") else "",
            f"Never guess or make up web addresses: only open addresses from {'search results, ' if off('web_search') else ''}the user, or pages you read."
            if off("fetch_web_page") else "",
            "To find something from the user’s earlier chats, meetings or Gallery, use search_my_history, then open_from_history." if off("search_my_history") else "",
            "You run on the user’s Tiiny device: never unload the model you are running on, because that ends this chat. generate_image makes room in NPU memory by itself.",
        ) if x)]
        pc_tools = [n for n in at.COMPUTER_TOOLS if off(n) and at.BY_NAME[n].available(ctx)]
        if ctx.computer() and pc_tools:
            e = commands.environment()
            where = (f"the server the panel runs on, inside its container, which only sees the folders mounted into it ({e['os']}, "
                     f"{e['shell']}, home folder {e['home']})" if self.env.container else
                     f"the server the panel runs on ({e['os']}, {e['shell']}, user {e['user']}, home folder {e['home']})" if self.env.server else
                     f"the user’s computer ({e['os']}, {e['shell']}, user {e['user']}, home folder {e['home']})")
            out.append(" ".join(x for x in (
                f"You can also work on {where} with {', '.join(pc_tools)}.",
                "The user approves every command, file change and file opened, so say in one short sentence what you are about to do and why.",
                "Never delete, move or overwrite the user’s files unless they asked for exactly that.",
                "Prefer commands that only look at things. Don’t use sudo: there’s nowhere to type a password, so tell the user to run admin commands "
                "themselves. Commands get no input and must finish by themselves; start long-running programs in the background. Check the output and the "
                "exit code before you say something worked." if "run_command" in pc_tools else "",
            ) if x))
        return out

    def _stream(self, body: dict) -> dict:
        """One completion, streamed into the reply. {content, reasoning, tool_calls, usage, finish, model} (agent.js: streamChat)."""
        payload, extras = device.chat_request(body)
        model = payload["model"]
        USAGE.touch(model)
        out = {"content": "", "reasoning": "", "tool_calls": [], "usage": None, "finish": None, "model": None}
        calls = {}
        with activity.track("/v1/chat/completions", model, phone=self.remote) as entry:
            self._stream_started = time.time()
            first = threading.Event()   # this completion's first token (or tool call)
            note = threading.Timer(WAITING_NOTE_AFTER, self._say_waiting, args=(entry, model, first))
            note.daemon = True
            note.start()
            gen = device.stream_chat(self.info(), payload, extras)
            try:
                for ev in gen:
                    self.job.check()
                    if ev[0] in ("delta", "tool_delta") and not first.is_set():
                        first.set()
                        if self._waiting_said:
                            self._waiting_said = False
                            self.status("")
                    if ev[0] == "delta":
                        if self.t_first is None:
                            self.t_first = time.time()
                        c, r = ev[1] or "", ev[2] or ""
                        out["content"] += c
                        out["reasoning"] += r
                        self.delta(c, r)
                    elif ev[0] == "tool_delta":
                        for tc in ev[1] or []:
                            i = tc.get("index") if isinstance(tc.get("index"), int) else len(calls)
                            call = calls.setdefault(i, {"id": "", "name": "", "arguments": ""})
                            fn = tc.get("function") or {}
                            if tc.get("id"):
                                call["id"] = tc["id"]
                            if fn.get("name"):
                                call["name"] += fn["name"]
                            if fn.get("arguments"):
                                call["arguments"] += fn["arguments"] if isinstance(fn["arguments"], str) else json.dumps(fn["arguments"])
                    elif ev[0] == "info":
                        self.note(ev[1])
                    elif ev[0] == "done":
                        st = ev[1]
                        out.update(usage=st.get("usage"), finish=st.get("finish_reason"), model=st.get("model"))
                        if st.get("ttft") is not None and self.mgr.metrics is not None:
                            self.mgr.metrics.record_speed(st["model"], st["ttft"], st["tps"], st["tokens"])
                    self.maybe_save()
            finally:
                first.set()
                note.cancel()
                gen.close()
        self.flush()
        out["tool_calls"] = [dict(c, id=c["id"] or f"call_{new_id('')}") for _, c in sorted(calls.items()) if c["name"]]
        return out

    def _explain(self, e) -> str:
        """The error for the reply, in plain words where the device's own is cryptic."""
        msg = str(e) or e.__class__.__name__
        if self._waiting_said and "timed out waiting for data" in msg.lower():   # it waited its turn too long
            mins = round((time.time() - (self._stream_started or time.time())) / 60)
            took = f"about {mins} minute{'' if mins == 1 else 's'}" if mins >= 1 else "less than a minute"
            return (f"Your Tiiny gave up after waiting {took}: {self._waiting_model} was busy "
                    f"the whole time with {self._waiting_for}, and it answers one request at a time per model. Try again when "
                    "that's done, or stop it.")
        return msg

    def _say_waiting(self, entry, model, first):
        """No answer yet: say who's ahead. Your Tiiny answers one request at a time per model, in order, so a reply can
        wait behind the panel's other work on the same model (a code review, a routine, an app), or another app's."""
        if first.is_set():
            return
        ahead = activity.ahead_of(entry)
        name = npu.short(model)
        if ahead:
            titles = [a.get("title") or "another request" for a in ahead]
            who = f"“{titles[0]}”" if len(titles) == 1 else f"{len(titles)} other requests"
            text = (f"Waiting for your Tiiny: it answers one request at a time per model, and “{titles[0]}” is using {name} first."
                    if len(titles) == 1 else
                    f"Waiting for your Tiiny: {len(titles)} other requests are using {name} first ({', '.join(titles[:3])}).")
        else:
            try:   # someone outside the panel: the device counts more requests on the model than the panel sent
                st, n, _ = device.call(self.info(), "core", "GET", "/api/v1/npu/status", timeout=10)
                active = sum(int(a.get("active_request_count") or 0) for o in (n or {}).get("occupants") or []
                             for a in o.get("activate_model") or [] if a.get("model_name") == model)
            except (DeviceError, ValueError, TypeError):
                return
            if active <= activity.on_model(model):
                return
            text = f"Waiting for your Tiiny: another app is using {name} first. It answers one request at a time per model."
            who = "another app"
        if not first.is_set():
            self._waiting_said, self._waiting_for, self._waiting_model = True, who, name
            self.status(text)

    def _allow_settings(self) -> tuple:
        """The chat's own approval settings as they are now (you may change them while it runs)."""
        try:
            rec = self.env.store.get("chats", self.chat_id) or {}
        except BadRequest:
            rec = {}
        allow = dict(rec.get("agentAllow") or self.chat.get("agentAllow") or {}, **self.allowed_now)
        return allow, bool(rec.get("agentAuto", self.chat.get("agentAuto")))

    def _wait_approval(self, i: int, label: str) -> str:
        w = {"event": threading.Event(), "decision": None}
        with self.lock:
            self.waiting[i] = w
        self.save(force=True)
        self.job.update(message=f"Waiting for your approval: {label}")
        deadline = time.time() + APPROVAL_WAIT
        try:
            while not w["event"].wait(0.5):
                self.job.check()
                self.maybe_save()
                if time.time() > deadline:
                    w["decision"] = "deny"
                    self.note("Nobody answered the approval within a day, so the step was skipped.")
                    break
        finally:
            with self.lock:
                self.waiting.pop(i, None)
            self.job.update(message="")
        return w["decision"] or "deny"

    def _agent(self, body: dict, ctx) -> dict:
        """The agent loop: call the model with tools until it answers without calling any (agent.js: runAgentTurn)."""
        chat, asst = self.chat, self.asst
        defs = [t.spec() for t in at.offered(ctx)]
        msgs = list(body["messages"])
        model = body.get("model")
        if model and model != "default":
            ctx.self_models.add(model)
        model_ids = {m["id"]: m for m in self._models()}
        for _ in range(at.MAX_STEPS):
            self.set(content="")
            res = self._stream(dict(body, messages=msgs, tools=defs, tool_choice="auto") if defs else dict(body, messages=msgs))
            self.meta(usage=add_usage(asst["meta"].get("usage"), res["usage"]))
            if res.get("model") in model_ids:
                ctx.self_models.add(res["model"])
            if not ctx.self_models:
                running = set(device.running_ids(self.info()))
                ctx.self_models.update(m for m in running if at.CHAT_TYPE.search((model_ids.get(m) or {}).get("type") or ""))
            calls = res["tool_calls"]
            if not calls and "<tool_call>" in asst["content"]:
                calls, text = extract_inline_tool_calls(asst["content"])
                self.set(content=text)
            if not calls:
                return res
            said = split_thinking({"content": asst["content"]})[1].strip()
            if said:
                self.add_step({"type": "thought", "text": said})
            self.set(content="")
            msgs.append({"role": "assistant", "content": res["content"] if res["content"] and "<tool_call>" not in res["content"] else "",
                         "tool_calls": [{"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"] or "{}"}} for c in calls]})
            for c in calls:
                result = self._tool_step(c, ctx)
                msgs.append({"role": "tool", "tool_call_id": c["id"], "content": str(result)[:14000]})
                self.save(force=True)
                self.job.check()
        self.note(f"Stopped after {at.MAX_STEPS} tool steps. Ask a follow-up to continue.")
        return {"content": asst["content"], "usage": None, "finish": None, "model": None}

    def _tool_step(self, c: dict, ctx) -> str:
        tool = at.BY_NAME.get(c["name"])
        args = parse_tool_args(c["arguments"])
        st = {"type": "tool", "name": c["name"], "args": args, "label": tool.label(args) if tool else f"Unknown tool {c['name']}",
              "status": "running", "preview": None, "alwaysAsk": bool(tool and tool.always_ask)}
        if tool:
            st["risk"] = tool.risk
        i = self.add_step(st)
        settings = self.env.settings
        if not tool:
            result = f"There is no tool called {c['name']}."
            self.step(i, status="error")
        elif not at.switched_on(tool, settings) or not tool.available(ctx):
            off = not at.switched_on(tool, settings)
            result = (f"{c['name']} is switched off in System → Agent tools, so it wasn’t used. Carry on without it, or tell the user they can "
                      "switch it on there." if off else f"{c['name']} isn’t available here.")
            self.step(i, status="denied", summary="switched off" if off else "not available")
        elif self.unattended and not tool.always_ask and tool.risk != "read" and tool.name not in (self.allowed or ()):
            result = f"This routine may not use {c['name']} by itself, so it wasn’t used. Carry on without it."
            self.step(i, status="denied", summary="not allowed in this routine")
        else:
            refused = tool.refuse(args, ctx) if tool.refuse else None
            if refused:
                result = refused
                self.step(i, status="denied", summary="not allowed")
            else:
                result = self._run_tool(i, tool, args, ctx)
        self.step(i, result=str(result)[:2000])
        return result

    def _run_tool(self, i, tool, args, ctx) -> str:
        try:
            preview = tool.preview(args, ctx) if tool.preview else None
        except Exception:  # noqa: BLE001 - only a preview
            preview = None
        if preview:
            self.step(i, preview=preview)
        allow, auto = self._allow_settings()
        ask = tool.always_ask if self.unattended else (tool.always_ask or (tool.risk != "read" and not allow.get(tool.name) and not auto))
        if ask:
            try:
                note = (tool.approval_note(args, ctx) if tool.approval_note else "") or ""
            except Exception:  # noqa: BLE001 - only a note
                note = ""
            self.step(i, note=note, status="approval")
            if tool.approval_hint:   # slower hints (a decision model) arrive while the card is already up
                def hint():
                    jobmod.working_for(self.job)
                    try:
                        extra = tool.approval_hint(args, ctx)
                    except Exception:  # noqa: BLE001
                        extra = ""
                    with self.lock:
                        cur = self.asst["steps"][i]
                        if extra and cur.get("status") == "approval":
                            self.step(i, note=" ".join(x for x in (cur.get("note"), extra) if x))
                threading.Thread(target=hint, daemon=True).start()
            decision = self._wait_approval(i, self.asst["steps"][i]["label"])
            if decision == "always" and not tool.always_ask:
                with self.lock:
                    self.allowed_now[tool.name] = True
                    self.chat["agentAllow"] = dict(self.chat.get("agentAllow") or {}, **{tool.name: True})
            if decision == "deny":
                self.step(i, status="denied")
                return "The user declined this action. Carry on without it, or ask them what to do."
        self.step(i, status="running")
        last = [0.0]

        def progress(text):
            if time.time() - last[0] >= 0.25 or not text:
                last[0] = time.time()
                self.step(i, progress=text or None)
            self.maybe_save()
        ctx.progress = progress
        try:
            out = tool.run(args, ctx)
            changes = {"summary": out.get("summary") or "", "status": "done"}
            for k, field in (("image", "image"), ("links", "links"), ("output", "output"), ("gallery_id", "galleryId")):
                if out.get(k) is not None:
                    changes[field] = out[k]
            self.step(i, **changes)
            if len(self.asst["meta"]["sources"]) != getattr(self, "_sources_sent", 0):
                self._sources_sent = len(self.asst["meta"]["sources"])
                self.meta(sources=self.asst["meta"]["sources"])
            return out.get("content") or ""
        except Cancelled:
            raise
        except Exception as e:  # noqa: BLE001 - the model hears what went wrong
            if not isinstance(e, (at.ToolError, BadRequest, DeviceError, OSError, ValueError)):
                traceback.print_exc()
            msg = str(e) or e.__class__.__name__
            self.step(i, status="error", error=msg)
            return f"The tool failed: {msg}"
        finally:
            self.step(i, progress=None)
            ctx.progress = lambda text: None


# -- all replies ----------------------------------------------------------------------------------------------------------
class Turns:
    def __init__(self, env, metrics=None):
        self.env, self.metrics = env, metrics
        self.lock = threading.Lock()
        self.by_job = {}

    def _clean(self):
        cutoff = time.time() - KEEP_FINISHED
        for jid, t in list(self.by_job.items()):
            if t.finished_at and t.finished_at < cutoff:
                del self.by_job[jid]

    def get(self, jid):
        with self.lock:
            return self.by_job.get(jid)

    def running_for(self, chat_id):
        with self.lock:
            return next((t for t in self.by_job.values() if t.chat_id == chat_id and t.job and not t.job.finished), None)

    def listing(self) -> dict:
        """The replies being written, and the ones that finished in the last KEEP_FINISHED seconds with the chat's rev
        after them, so a page showing an older copy of that chat knows to load it again."""
        with self.lock:
            turns = [t for t in self.by_job.values() if t.job]
        return {"turns": [{"id": t.job.id, "chat": t.chat_id, "waiting": bool(t.waiting), "waiting_steps": sorted(t.waiting),
                           "title": t.job.title, "started": t.job.created, "phone": t.remote, "routine": t.why or None, "rev": t.rev}
                          for t in turns if not t.job.finished],
                "recent": [{"id": t.job.id, "chat": t.chat_id, "rev": t.rev} for t in turns if t.job.finished]}

    def start(self, chat_id: str, *, remote=False, unattended=False, allowed=None, instructions="", why="", routine=None):
        """Start writing the reply to the chat's last message. Returns the job. A routine's reply (routine: its id) gives
        back the models it loaded (npu.ensure_ready doesn't keep them for the job)."""
        store = self.env.store
        with store.locks["chats"], self.lock:
            if any(t.chat_id == chat_id and t.job and not t.job.finished for t in self.by_job.values()):
                raise BadRequest("A reply is already being written in this chat.")
            rec = store.get("chats", chat_id)
            if not rec:
                raise BadRequest("That chat no longer exists.")
            if not any(m.get("role") == "user" for m in rec.get("messages") or [] if isinstance(m, dict)):
                raise BadRequest("There’s no message to reply to yet.")
            for m in rec.get("messages") or []:   # a reply that was cut off earlier (the panel stopped) says so
                if isinstance(m, dict) and m.get("pending"):
                    m["pending"] = False
                    if not m.get("content") and not m.get("error"):
                        m["error"] = "Interrupted."
            turn = Turn(self, rec, remote=remote, unattended=unattended, allowed=allowed, instructions=instructions, why=why)
            rec["rev"] = (rec.get("rev") or 0) + 1
            turn.rev = rec["rev"]
            store.put("chats", rec, chat_id)   # the pending reply is in the chat before anyone looks
            title = why or f"Chat: {rec.get('title') or 'New chat'}"   # a routine's reply is named after the routine
            meta = {"chat": chat_id, "href": f"chat/{chat_id}"}
            if routine:
                meta["routine"] = routine
            job = self.env.jobs.start("chat-turn", title, turn.run, meta)
            self.by_job[job.id] = turn
            self._clean()
        return job

    def approve(self, jid: str, step, decision: str, remote=False):
        turn = self.get(jid)
        if not turn or turn.job.finished:
            raise BadRequest("That reply has finished.")
        if decision not in ("once", "always", "deny"):
            raise BadRequest("Answer once, always or deny.")
        with turn.lock:
            try:
                i = int(step)
                st = turn.asst["steps"][i]
            except (TypeError, ValueError, IndexError):
                raise BadRequest("There's no such step.") from None
            w = turn.waiting.get(i)
            if not w or st.get("status") != "approval":
                raise BadRequest("That step isn’t waiting for an answer any more.")
            if remote and st.get("risk") in COMPUTER_RISKS and decision != "deny":
                raise PermissionError("This step works on the computer the panel runs on, so it can only be allowed there.")
            if decision == "always" and st.get("alwaysAsk"):
                decision = "once"
            turn.step(i, status="denied" if decision == "deny" else "running")
            w["decision"] = decision
            w["event"].set()
        return {"ok": True}

    def stop(self, jid: str) -> bool:
        turn = self.get(jid)
        if not turn or turn.job.finished:
            return False
        turn.job.cancel_event.set()
        turn.job.update(message="Stopping…")
        model = turn.asst["meta"].get("model")
        if model and model != "default":   # the model stops writing at once (chat.js: stop)
            def interrupt():
                try:
                    device.call(turn.info(), "core", "POST", f"/api/v1/models/{urllib.parse.quote(model, safe='/')}/interrupt", timeout=15)
                except DeviceError:
                    pass
            threading.Thread(target=interrupt, daemon=True).start()
        return True

    def merge_put(self, rid: str, rec: dict) -> tuple:
        """A page saving a chat: (the record to keep, whether the server's messages were kept). Call it under the store's chats lock.
        The page's messages are kept unless a reply is being written, the page's copy is older than what's saved (rev), or
        it would save a reply that's still being written (pending)."""
        stored = self.env.store.get("chats", rid)
        if not stored:
            return rec, False
        turn = self.running_for(rid)
        mine = rec.get("messages") if isinstance(rec.get("messages"), list) else []
        stale = (rec.get("rev") or 0) < (stored.get("rev") or 0)
        pending = any(isinstance(m, dict) and m.get("pending") for m in mine)
        if turn is None and not stale and not pending:
            out = dict(rec)
            if mine != stored.get("messages"):
                out["rev"] = (stored.get("rev") or 0) + 1
            else:
                out["rev"] = stored.get("rev") or 0
            return out, False
        out = dict(rec, messages=stored.get("messages") or [], rev=stored.get("rev") or 0)
        if turn is not None:
            out["agentAllow"] = dict(rec.get("agentAllow") or {}, **turn.allowed_now)
        return out, True
