"""Decision models: "Text Classification" models such as KnowLine and d3, through the device's /v1/systemone (the
System One format of llama.cpp and vLLM Semantic Router).

You send a state (text, a chat, pictures) and typed questions; the model gives a probability for every answer in one
forward pass, without generating text (about 0.2 s for one question on KnowLine-4B, 1.4 s with a picture, 7.6 s for
the maximum of 64). Question types:
  noul    yes/no                      {"type": "noul", "instructions": "Is the customer angry?"}
  choice  one of several labels       {"type": "choice", "instructions": "...", "criteria": {"billing": "refunds…", "other": None}}
  score   a scale, lowest first       {"type": "score", "instructions": "...", "criteria": ["low", "medium", "high"]}
The panel uses them for small decisions (which tools the agent gets, whether to think, whether a passage or a review
finding is relevant, picture tags, …). Every caller falls back to what the panel did before when no decision model can
answer (Unavailable): none on the device, it doesn't fit in NPU memory next to the loaded models, or the feature is
switched off under System → Decision models.
"""

from __future__ import annotations

import re
import threading

from . import device, npu
from .common import DeviceError, error_message

MAX_QUESTIONS = 64       # the device refuses more ("at most 64 are supported")
MAX_LEVELS = 10          # score: 2..10 levels (the device takes up to 255; more isn't useful here)
MAX_STATE = 400_000      # characters of text state (KnowLine reads 256k tokens, d3 16k)
FEATURES = {             # key → what it does (System → Decision models has a switch for each)
    "agent_tools": "The agent gets only the tools a message needs",
    "chat_thinking": "Automatic thinking in chat",
    "vault_filter": "Leave out Vault passages that don't fit the question",
    "command_risk": "Risk notes on commands the agent wants to run",
    "review_check": "Check code-review findings",
    "gallery_tags": "Tag pictures in the Gallery",
    "project_memory": "Skip project memory updates with nothing to remember",
    "meeting_highlights": "Find action items, decisions and questions in meetings",
}
_load_lock = threading.Lock()
_settings = None  # the panel's settings (tiiny_ui.py passes them once), for features that don't carry them


def use_settings(settings):
    global _settings
    _settings = settings


class Unavailable(Exception):
    """No decision model can answer right now. Callers fall back to what they did before."""


def is_decider(m: dict) -> bool:
    return bool(re.search(r"classif", str(m.get("type") or ""), re.I)) or "systemone" in (m.get("capabilities") or [])


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None


# -- asking ---------------------------------------------------------------------------------------------------------
def check_questions(questions) -> dict:
    """The questions as the device wants them; raises ValueError with a plain message otherwise."""
    if not isinstance(questions, dict) or not questions:
        raise ValueError("Ask at least one question.")
    if len(questions) > MAX_QUESTIONS:
        raise ValueError(f"At most {MAX_QUESTIONS} questions fit in one request.")
    out = {}
    for qid, q in questions.items():
        if not isinstance(qid, str) or not re.fullmatch(r"[\w.-]{1,64}", qid):
            raise ValueError("Question ids are short names made of letters, digits, _ . -")
        if not isinstance(q, dict):
            raise ValueError(f"Question {qid} isn't a question.")
        kind, text = q.get("type"), str(q.get("instructions") or "").strip()
        if kind not in ("noul", "choice", "score"):
            raise ValueError(f"Question {qid}: the type is yes/no (noul), choice or score.")
        if not text:
            raise ValueError(f"Question {qid} has no question text.")
        item = {"type": kind, "instructions": text[:4000]}
        crit = q.get("criteria")
        if kind == "choice":
            if not isinstance(crit, dict) or not 2 <= len(crit) <= 32:
                raise ValueError(f"Question {qid}: give 2 to 32 options.")
            item["criteria"] = {str(k)[:120]: (str(v)[:500] if v else None) for k, v in crit.items()}
        elif kind == "score":
            if not isinstance(crit, list) or not 2 <= len(crit) <= MAX_LEVELS:
                raise ValueError(f"Question {qid}: give 2 to {MAX_LEVELS} levels, lowest first.")
            item["criteria"] = [str(x)[:120] for x in crit]
        out[qid] = item
    return out


def _state(state):
    if isinstance(state, str):
        return state[:MAX_STATE]
    if isinstance(state, list) and all(isinstance(m, dict) for m in state):
        return [{"role": str(m.get("role") or "user"), "content": m.get("content")} for m in state[-40:]]
    raise ValueError("The state is a text or a list of chat messages.")


def normalize(q: dict, a) -> dict:
    """One shape for every answer: {"type", "p": {answer: probability}, "best", "confidence"}, plus "yes" for yes/no
    questions and "value" (the expected level, 0 = lowest) for scores."""
    kind = q["type"]
    if not isinstance(a, dict):
        return {"type": kind, "p": {}, "best": None, "missing": True}
    if kind == "noul":
        p = _num(a.get("noul") if "noul" in a else a.get("probability"))
        if p is None:
            return {"type": kind, "p": {}, "best": None, "missing": True}
        return {"type": kind, "yes": p, "p": {"yes": p, "no": 1 - p}, "best": "yes" if p >= 0.5 else "no", "confidence": abs(p - 0.5) * 2}
    raw = a.get("probabilities")
    if isinstance(raw, list):
        raw = {str(i): v for i, v in enumerate(raw)}
    raw = raw if isinstance(raw, dict) else {}
    if kind == "choice":
        labels = list(q["criteria"])
        p = {}
        for k, v in raw.items():
            if _num(v) is None:
                continue
            k = labels[int(k)] if str(k).isdigit() and k not in q["criteria"] and int(k) < len(labels) else str(k)
            p[k] = _num(v)
        best = a.get("choice") if a.get("choice") in q["criteria"] else (max(p, key=p.get) if p else None)
        return {"type": kind, "p": p, "best": best, "confidence": _num(a.get("confidence"))}
    levels = q["criteria"]
    p = {}
    for k, v in raw.items():
        if _num(v) is None:
            continue
        k = levels[int(k)] if str(k).isdigit() and int(k) < len(levels) else str(k)
        p[k] = _num(v)
    value = _num(a.get("score"))
    if value is None and p:
        value = sum(levels.index(k) * v for k, v in p.items() if k in levels)
    best = levels[max(0, min(len(levels) - 1, int(value + 0.5)))] if value is not None else None
    return {"type": kind, "p": p, "best": best, "value": value, "confidence": _num(a.get("confidence"))}


def ask(info, model: str, state, questions: dict, images=None, timeout: float = 60) -> dict:
    """Ask a loaded decision model. Returns {"model", "answers": {id: normalize(...)}, "usage"}."""
    qs = check_questions(questions)
    body = {"model": model, "state": _state(state), "questions": qs}
    if images:
        body["images"] = [str(x) for x in images[:4] if str(x).startswith("data:image/")]
    status, data, text = device.call(info, "core", "POST", "/v1/systemone", body=body, timeout=timeout)
    if status == 404 and "not loaded" in (text or ""):
        raise Unavailable(f"{short(model)} isn't loaded.")
    if not 200 <= status < 300:
        raise DeviceError(error_message(data, text, status))
    answers = (data or {}).get("answers") if isinstance(data, dict) else None
    answers = answers if isinstance(answers, dict) else {}
    return {"model": (data or {}).get("model") or model, "usage": (data or {}).get("usage") or {},
            "answers": {qid: normalize(q, answers.get(qid)) for qid, q in qs.items()}}


# -- which model, loaded when needed ----------------------------------------------------------------------------------
def short(mid: str) -> str:
    return str(mid or "").split("/")[-1]


def choose(info, settings) -> tuple:
    """(the decision model to use, all models on the device, the loaded ids)."""
    models = device.list_models(info)
    deciders = [m for m in models if is_decider(m)]
    if not deciders:
        raise Unavailable("There's no decision model on your Tiiny. Get one from the model store, for example KnowLine-4B or d3-lite.")
    running = set(device.running_ids(info))
    want = settings.get("decision_model") or ""
    picked = next((m for m in deciders if m["id"] == want), None)
    if not picked:
        loaded = [m for m in deciders if m["id"] in running]
        picked = loaded[0] if loaded else min(deciders, key=lambda m: _num(m.get("npu_usage")) or 999)
    return picked, models, running


def ensure(info, settings, allow_load: bool = True) -> str:
    """The id of a loaded decision model, loading the chosen one first if it fits next to what's loaded. It never
    unloads anything to make room: if it doesn't fit, the feature just isn't used (Unavailable)."""
    m, models, running = choose(info, settings)
    if m["id"] in running:
        return m["id"]
    if not allow_load:
        raise Unavailable(f"{short(m['id'])} isn't loaded.")
    with _load_lock:  # several features can ask at once: load once
        running = set(device.running_ids(info))
        if m["id"] in running:
            return m["id"]
        p = npu.plan(m["id"], info=info)   # both the memory in use and the device's own count (see npu.py)
        if not p["fits"]:
            raise Unavailable(npu.describe(p))
        try:
            npu.ensure_ready(m["id"], policy="fits", info=info)
        except DeviceError as e:
            raise Unavailable(f"{short(m['id'])} couldn't be loaded: {e}")
    return m["id"]


def decide(devconn, settings, feature: str, state, questions: dict, images=None, allow_load: bool = True, timeout: float = 60) -> dict:
    """What a feature calls: checks its switch, makes sure a decision model is loaded, asks."""
    settings = settings or _settings
    if settings is None:
        raise Unavailable("Decision models aren't set up in this panel.")
    if feature in (settings.get("decisions_off") or []):
        raise Unavailable("This is switched off under System → Decision models.")
    check_questions(questions)  # a bad request is refused before anything gets loaded
    _state(state)
    info = devconn.resolve()
    try:
        model = ensure(info, settings, allow_load)
        return ask(info, model, state, questions, images, timeout)
    except DeviceError as e:  # the device went away mid-way: the feature falls back
        raise Unavailable(str(e))
