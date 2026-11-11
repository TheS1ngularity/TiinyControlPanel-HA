"""Web search for agent mode, so the model finds real addresses instead of guessing them.

Engines (chosen under System → Agent tools):
- DuckDuckGo (the default): its plain HTML search page. No account or key.
- Brave Search: Brave's official search API. Needs a key from https://api-dashboard.search.brave.com/.
- SearXNG: your own metasearch server, which can include Google and other engines. Its JSON output must
  be switched on (search: formats: [html, json] in its settings.yml).

(Google's own Custom Search JSON API is closed to new customers and shuts down on 1 January 2027, and
Google doesn't allow programs to read its result pages, so it isn't offered directly.)

Only the search words go to the engine. Results are cached for a few minutes, so a model repeating the
same search doesn't send it again.
"""

from __future__ import annotations

import html
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

from .common import BadRequest

ENGINES = {"duckduckgo": "DuckDuckGo", "brave": "Brave Search", "searxng": "SearXNG"}
RECENCY = ("day", "week", "month", "year")
MAX_RESULTS = 10
TIMEOUT = 20
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
DDG_HTML = "https://html.duckduckgo.com/html/"
DDG_LITE = "https://lite.duckduckgo.com/lite/"
BRAVE_URL = "https://api.search.brave.com/res/v1/web/search"
CACHE_SECONDS = 600

_cache = {}
_cache_lock = threading.Lock()


def _clean(text: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", text or "")).split())


def _result(url: str, title: str, snippet: str):
    url = (url or "").strip()
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    return {"title": _clean(title)[:300] or parts.netloc, "url": url, "snippet": _clean(snippet)[:600]}


def _open(req: urllib.request.Request, who: str):
    """(status, text) for a request; raises BadRequest with a plain message when the engine can't be reached."""
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, r.read(3_000_000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(200_000).decode("utf-8", "replace")
    except (urllib.error.URLError, OSError) as e:
        reason = getattr(e, "reason", e)
        raise BadRequest(f"Couldn't reach {who}: {reason}") from None


# ---- DuckDuckGo -----------------------------------------------------------------------------
class _DuckPage(HTMLParser):
    """Results from DuckDuckGo's HTML page (result__a, result__snippet) or its lite page
    (result-link, result-snippet in table rows). Sponsored results are left out."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.results = []
        self.cur = None          # the result whose title is being read
        self.field = ""          # "title" or "snippet"
        self.field_tag = ""
        self.sponsored = False   # lite: inside a sponsored table row
        self.ad = False          # html: inside a result--ad block

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = (a.get("class") or "").split()
        if tag == "tr":
            self.sponsored = "result-sponsored" in cls
        if tag == "div" and "result" in cls:
            self.ad = "result--ad" in cls
        if tag == "a" and ("result__a" in cls or "result-link" in cls):
            self.cur = {"url": _duck_url(a.get("href") or ""), "title": "", "snippet": "", "skip": self.sponsored or self.ad}
            self.field, self.field_tag = "title", "a"
        elif ("result__snippet" in cls or "result-snippet" in cls) and self.results and not self.field:
            self.field, self.field_tag = "snippet", tag

    def handle_endtag(self, tag):
        if self.field == "title" and tag == "a":
            cur, self.cur, self.field = self.cur, None, ""
            if cur and not cur["skip"] and cur["url"]:
                self.results.append(cur)
        elif self.field == "snippet" and tag == self.field_tag:
            self.field = ""

    def handle_data(self, data):
        if self.field == "title" and self.cur is not None:
            self.cur["title"] += data
        elif self.field == "snippet" and self.results:
            self.results[-1]["snippet"] += data


def _duck_url(href: str) -> str:
    href = html.unescape(href or "")
    if href.startswith("//"):
        href = "https:" + href
    parts = urllib.parse.urlsplit(href)
    if parts.netloc.endswith("duckduckgo.com"):
        target = urllib.parse.parse_qs(parts.query).get("uddg", [""])[0]
        return target if parts.path.startswith("/l/") and target else ""   # anything else is an ad or a help page
    return href


def _duckduckgo(query: str, count: int, recency: str) -> list:
    form = {"q": query, "b": "", "kl": ""}
    if recency:
        form["df"] = recency[0]  # d, w, m, y
    blocked = False
    for url in (DDG_HTML, DDG_LITE):
        req = urllib.request.Request(url, data=urllib.parse.urlencode(form).encode(), headers={
            "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", "Referer": url,
            "Accept": "text/html", "Accept-Language": "en-US,en;q=0.8"})
        status, text = _open(req, "DuckDuckGo")
        page = _DuckPage()
        page.feed(text)
        out, seen = [], set()
        for r in page.results:
            res = _result(r["url"], r["title"], r["snippet"])
            if res and res["url"] not in seen:
                seen.add(res["url"])
                out.append(res)
        if out:
            return out[:count]
        if status == 202 or "anomaly" in text.lower() or status >= 400:
            blocked = True  # a bot check: the other page sometimes still works
            continue
        if "No results" in text or "no-results" in text or status == 200:
            return []
    if blocked:
        raise BadRequest("DuckDuckGo didn't answer the search: it sometimes pauses automated searches for a while. "
                         "Try again in a few minutes, or choose Brave Search or your own SearXNG under System → Agent tools.")
    return []


# ---- Brave Search ---------------------------------------------------------------------------
def _brave(query: str, count: int, recency: str, key: str) -> list:
    if not key:
        raise BadRequest("Brave Search needs an API key. Add it under System → Agent tools, or switch to DuckDuckGo.")
    params = {"q": query, "count": count}
    if recency:
        params["freshness"] = {"day": "pd", "week": "pw", "month": "pm", "year": "py"}[recency]
    req = urllib.request.Request(f"{BRAVE_URL}?{urllib.parse.urlencode(params)}", headers={
        "Accept": "application/json", "X-Subscription-Token": key, "User-Agent": UA})
    status, text = _open(req, "Brave Search")
    if status in (401, 403, 422):
        raise BadRequest("Brave Search didn't accept the API key. Check it under System → Agent tools.")
    if status == 429:
        raise BadRequest("Brave Search says the key's limit is used up, or there were too many searches at once. Try again later.")
    if status != 200:
        raise BadRequest(f"Brave Search answered HTTP {status}.")
    try:
        items = (json.loads(text).get("web") or {}).get("results") or []
    except ValueError:
        raise BadRequest("Brave Search sent an answer the panel couldn't read.") from None
    return [r for r in (_result(i.get("url"), i.get("title"), i.get("description")) for i in items if isinstance(i, dict)) if r][:count]


# ---- SearXNG ---------------------------------------------------------------------------------
def _searxng(query: str, count: int, recency: str, base: str) -> list:
    base = (base or "").strip().rstrip("/")
    if not re.match(r"^https?://[^\s/]+", base):
        raise BadRequest("Set your SearXNG address (like http://192.168.1.20:8080) under System → Agent tools.")
    params = {"q": query, "format": "json"}
    if recency:
        params["time_range"] = recency
    req = urllib.request.Request(f"{base}/search?{urllib.parse.urlencode(params)}", headers={"Accept": "application/json", "User-Agent": UA})
    status, text = _open(req, "your SearXNG")
    if status == 403:
        raise BadRequest("Your SearXNG doesn't allow JSON results. In its settings.yml, add json under search: formats:, then restart it.")
    if status == 429:
        raise BadRequest("Your SearXNG refused the search (too many requests). If it has a limiter, allow this computer.")
    if status != 200:
        raise BadRequest(f"Your SearXNG answered HTTP {status}.")
    try:
        items = json.loads(text).get("results") or []
    except ValueError:
        raise BadRequest("Your SearXNG didn't send JSON. Check the address under System → Agent tools.") from None
    out, seen = [], set()
    for i in items:
        r = _result(i.get("url"), i.get("title"), i.get("content")) if isinstance(i, dict) else None
        if r and r["url"] not in seen:
            seen.add(r["url"])
            out.append(r)
    return out[:count]


def search(query: str, count: int = 6, recency: str = "", engine: str = "duckduckgo", brave_key: str = "",
           searxng_url: str = "") -> dict:
    """Search the web. Returns {engine, query, results: [{title, url, snippet}]}."""
    query = " ".join(str(query or "").split())[:400]
    if not query:
        raise BadRequest("Say what to search for.")
    try:
        count = max(1, min(MAX_RESULTS, int(count or 6)))
    except (TypeError, ValueError):
        count = 6
    recency = recency if recency in RECENCY else ""
    engine = engine if engine in ENGINES else "duckduckgo"
    key = (engine, query.lower(), count, recency, searxng_url if engine == "searxng" else "")
    now = time.time()
    with _cache_lock:
        for k in [k for k, (t, _) in _cache.items() if now - t > CACHE_SECONDS]:
            del _cache[k]
        if key in _cache:
            return _cache[key][1]
    if engine == "brave":
        results = _brave(query, count, recency, brave_key)
    elif engine == "searxng":
        results = _searxng(query, count, recency, searxng_url)
    else:
        results = _duckduckgo(query, count, recency)
    out = {"engine": ENGINES[engine], "query": query, "results": results}
    with _cache_lock:
        _cache[key] = (now, out)
        while len(_cache) > 100:
            del _cache[next(iter(_cache))]
    return out
