"""Fetch a web page and keep its readable text (for the Vault, projects and the agent)."""

from __future__ import annotations

import http.client
import ipaddress
import re
import socket
import tempfile
import urllib.error
import urllib.parse
import urllib.request

from .common import BadRequest
from .pdftext import PdfError, extract_pdf_text
from .textextract import html_to_text

MAX_BYTES = 10 * 1024 * 1024
UA = "Mozilla/5.0 (X11; Linux x86_64) TiinyControlPanel/1.0 (+local)"


class _Redirects(urllib.request.HTTPRedirectHandler):
    max_redirections = 5


_OPENER = urllib.request.build_opener(_Redirects())


def _blocked_ip(ip) -> bool:
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified


def _check_peer(sock):
    """After connecting: refuse if the address actually reached is on a private network.
    Checking the connection itself also covers redirects and names that change address (DNS rebinding)."""
    try:
        ip = ipaddress.ip_address(sock.getpeername()[0].split("%")[0])
    except (OSError, ValueError):
        return
    if _blocked_ip(ip):
        sock.close()
        raise BadRequest("That address is on your local network, so the panel won't fetch it from here.")


class _PublicHTTPConnection(http.client.HTTPConnection):
    def connect(self):
        super().connect()
        _check_peer(self.sock)


class _PublicHTTPSConnection(http.client.HTTPSConnection):
    def connect(self):
        super().connect()
        _check_peer(self.sock)


class _PublicHTTPHandler(urllib.request.HTTPHandler):
    def do_open(self, http_class, req, **kw):
        return super().do_open(_PublicHTTPConnection, req, **kw)


class _PublicHTTPSHandler(urllib.request.HTTPSHandler):
    def do_open(self, http_class, req, **kw):
        return super().do_open(_PublicHTTPSConnection, req, **kw)


# Used for requests from paired phones: never reaches this computer or the local network.
_PUBLIC_OPENER = urllib.request.build_opener(_Redirects(), _PublicHTTPHandler(), _PublicHTTPSHandler())


def _is_private(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0].split("%")[0])
        except ValueError:
            continue
        if _blocked_ip(ip):
            return True
    return False


def fetch(url: str, allow_private: bool = True, timeout: float = 20) -> dict:
    """Download url (http/https). Returns {url, final_url, title, text, excerpt, kind, description}."""
    url = (url or "").strip()
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url if url and "://" not in url else url
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise BadRequest("Use a web address that starts with http:// or https://")
    if not allow_private and _is_private(parts.hostname):
        raise BadRequest("That address is on your local network. Fetch it yourself if you trust it.")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml,text/plain,application/pdf;q=0.9,*/*;q=0.5",
                                               "Accept-Language": "en;q=0.9,*;q=0.5"})
    try:
        with (_OPENER if allow_private else _PUBLIC_OPENER).open(req, timeout=timeout) as r:
            ctype = (r.headers.get("Content-Type") or "").lower()
            data = r.read(MAX_BYTES + 1)
            final = r.geturl()
    except urllib.error.HTTPError as e:
        raise BadRequest(f"The site answered HTTP {e.code} {e.reason}.")
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise BadRequest(f"Couldn't load that page: {getattr(e, 'reason', e)}")
    if len(data) > MAX_BYTES:
        raise BadRequest("That page is larger than 10 MB.")
    charset = (re.search(r"charset=([\w-]+)", ctype) or [None, "utf-8"])[1]
    if "pdf" in ctype or data[:5] == b"%PDF-":
        try:
            text = extract_pdf_text(data)
        except PdfError as e:
            raise BadRequest(str(e))
        title = urllib.parse.unquote(final.rsplit("/", 1)[-1]) or parts.hostname
        page = {"title": title, "text": text, "description": ""}
        kind = "pdf"
    elif "html" in ctype or data.lstrip()[:15].lower().startswith((b"<!doctype", b"<html")):
        raw = data.decode(charset, "replace")
        m = re.search(r'<meta[^>]+charset=["\']?([\w-]+)', raw[:4000], re.I)
        if m and m.group(1).lower() not in (charset.lower(), "utf8"):
            try:
                raw = data.decode(m.group(1), "replace")
            except LookupError:
                pass
        page = html_to_text(raw)
        kind = "html"
    elif ctype.startswith("text/") or "json" in ctype or "xml" in ctype or not ctype:
        page = {"title": final.rsplit("/", 1)[-1] or parts.hostname, "text": data.decode(charset, "replace"), "description": ""}
        kind = "text"
    else:
        raise BadRequest(f"That link points to a {ctype.split(';')[0]} file, not a page with text.")
    text = page["text"].strip()
    if len(text) < 40:
        raise BadRequest("That page has almost no readable text (it may need JavaScript to show its content).")
    excerpt = re.sub(r"\s+", " ", page.get("description") or text)[:280]
    return {"url": url, "final_url": final, "title": page["title"] or parts.hostname, "text": text[:2_000_000],
            "excerpt": excerpt, "kind": kind, "words": len(text.split())}


def page_markdown(page: dict, saved_at: str) -> str:
    return f"# {page['title']}\n\nSource: {page['final_url']}\nSaved: {saved_at}\n\n---\n\n{page['text']}\n"
