"""Turn files into plain text: documents, web pages, code. Standard library only."""

from __future__ import annotations

import html
import re
import shutil
import subprocess
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree

from .files import TEXT_EXTS, looks_textual, read_text
from .pdftext import PdfError, extract_pdf_text

MAX_CHARS = 2_000_000


class Unsupported(Exception):
    pass


# ---------------------------------------------------------------------------
# HTML → readable text
# ---------------------------------------------------------------------------

SKIP_TAGS = {"script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed", "select",
             "option", "button", "form", "input", "textarea", "nav", "aside", "footer", "head"}
SKIP_ROLES = {"navigation", "menu", "menubar", "banner", "contentinfo", "search", "dialog", "alert", "complementary"}
SKIP_TOKENS = {"nav", "navbar", "navbox", "navigation", "menu", "dropdown", "sidebar", "breadcrumb", "breadcrumbs",
               "cookie", "cookies", "consent", "share", "sharing", "social", "comments", "advert", "ads", "promo",
               "newsletter", "subscribe", "popup", "modal", "toc", "editsection", "footer", "skip", "related",
               "noprint", "catlinks", "lang", "langlist", "printfooter"}
BLOCK_TAGS = {"p", "div", "section", "article", "main", "header", "li", "ul", "ol", "dl", "dt", "dd", "table", "tr",
              "pre", "blockquote", "figure", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "br", "address"}


class _Readable(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.meta = {}
        self.parts = {"body": [], "main": []}
        self._skip = 0
        self._in_title = False
        self._main_depth = 0
        self._pre = 0
        self._stack = []

    def _emit(self, text):
        self.parts["body"].append(text)
        if self._main_depth:
            self.parts["main"].append(text)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "title":
            self._in_title = True
        if tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            if key in ("og:title", "description", "og:description", "author", "article:published_time"):
                self.meta[key] = a.get("content") or ""
        tokens = set(re.split(r"[^a-z0-9]+", f"{a.get('class') or ''} {a.get('id') or ''}".lower()))
        noisy = tag not in ("html", "body", "main", "article") and (
            (a.get("role") or "").lower() in SKIP_ROLES or bool(tokens & SKIP_TOKENS))
        if tag in SKIP_TAGS or noisy or a.get("aria-hidden") == "true" or "hidden" in a:
            if tag not in ("br", "hr", "input"):
                self._skip += 1
                self._stack.append(("skip", tag))
            return
        if tag in ("article", "main") or a.get("role") == "main":
            self._main_depth += 1
            self._stack.append(("main", tag))
        else:
            self._stack.append(("tag", tag))
        if self._skip:
            return
        if tag == "pre":
            self._pre += 1
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._emit("\n\n" + "#" * int(tag[1]) + " ")
        elif tag == "li":
            self._emit("\n- ")
        elif tag in ("br",):
            self._emit("\n")
        elif tag in BLOCK_TAGS:
            self._emit("\n\n")
        elif tag in ("td", "th"):
            self._emit(" | ")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        while self._stack:
            kind, t = self._stack.pop()
            if kind == "skip":
                self._skip -= 1
            elif kind == "main":
                self._main_depth -= 1
            if t == "pre" and kind != "skip":
                self._pre = max(0, self._pre - 1)
            if t == tag:
                break
        if not self._skip and tag in BLOCK_TAGS:
            self._emit("\n\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
            return
        if self._skip:
            return
        self._emit(data if self._pre else re.sub(r"\s+", " ", data))


def _clean(text: str) -> str:
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def html_to_text(raw: str) -> dict:
    p = _Readable()
    try:
        p.feed(raw)
        p.close()
    except Exception:  # noqa: BLE001 - malformed markup: keep what we have
        pass
    body = _clean("".join(p.parts["body"]))
    main = _clean("".join(p.parts["main"]))
    text = main if len(main) > 400 or (main and len(main) > 0.3 * len(body)) else body
    title = (p.meta.get("og:title") or p.title or "").strip()
    return {"title": html.unescape(re.sub(r"\s+", " ", title))[:300], "text": text,
            "description": p.meta.get("description") or p.meta.get("og:description") or ""}


# ---------------------------------------------------------------------------
# Office documents (they are zip files of XML)
# ---------------------------------------------------------------------------

def _xml_text(data: bytes, para_tags, text_tags, tab_tags=(), br_tags=()) -> str:
    out = []
    try:
        root = ElementTree.fromstring(data)
    except ElementTree.ParseError:
        return ""

    def walk(el):
        tag = el.tag.split("}")[-1]
        if tag in text_tags and el.text:
            out.append(el.text)
        elif tag in tab_tags:
            out.append("\t")
        elif tag in br_tags:
            out.append("\n")
        for child in el:
            walk(child)
            if child.tail and tag not in text_tags and child.tag.split("}")[-1] in text_tags:
                pass
        if tag in para_tags:
            out.append("\n")

    walk(root)
    return "".join(out)


def _docx(z: zipfile.ZipFile) -> str:
    parts = [n for n in z.namelist() if re.fullmatch(r"word/(document|footnotes|endnotes)\d*\.xml", n)]
    parts.sort(key=lambda n: (not n.startswith("word/document"), n))
    return "\n".join(_xml_text(z.read(n), {"p"}, {"t"}, {"tab"}, {"br", "cr"}) for n in parts)


def _pptx(z: zipfile.ZipFile) -> str:
    slides = sorted((n for n in z.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)),
                    key=lambda n: int(re.search(r"(\d+)", n.rsplit("/", 1)[-1]).group(1)))
    out = []
    for i, n in enumerate(slides, 1):
        out.append(f"## Slide {i}\n" + _xml_text(z.read(n), {"p"}, {"t"}, (), {"br"}))
    return "\n\n".join(out)


def _xlsx(z: zipfile.ZipFile) -> str:
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ElementTree.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root:
            shared.append("".join(t.text or "" for t in si.iter() if t.tag.endswith("}t")))
    out = []
    for n in sorted(x for x in z.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", x)):
        root = ElementTree.fromstring(z.read(n))
        out.append(f"## {n.rsplit('/', 1)[-1][:-4]}")
        for row in root.iter():
            if not row.tag.endswith("}row"):
                continue
            cells = []
            for c in row:
                v = next((x.text for x in c if x.tag.endswith("}v")), None)
                if c.get("t") == "s" and v is not None and v.isdigit() and int(v) < len(shared):
                    v = shared[int(v)]
                elif c.get("t") == "inlineStr":
                    v = "".join(t.text or "" for t in c.iter() if t.tag.endswith("}t"))
                cells.append(v or "")
            if any(cells):
                out.append("\t".join(cells))
            if len(out) > 20000:
                break
    return "\n".join(out)


def _odf(z: zipfile.ZipFile) -> str:
    return _xml_text(z.read("content.xml"), {"p", "h"}, {"p", "h", "span", "a", "s"}, {"tab"}, {"line-break"}) \
        if "content.xml" in z.namelist() else ""


def _epub(z: zipfile.ZipFile) -> str:
    names = sorted(n for n in z.namelist() if n.lower().endswith((".xhtml", ".html", ".htm")))
    return "\n\n".join(html_to_text(z.read(n).decode("utf-8", "replace"))["text"] for n in names)


# ---------------------------------------------------------------------------

def extract(path, name: str = None) -> dict:
    """Return {'text', 'kind', 'title'} for a file, or raise Unsupported with a friendly reason."""
    path = Path(path)
    name = name or path.name
    ext = Path(name).suffix.lower()
    title = Path(name).stem
    if ext == ".pdf":
        text = None
        if shutil.which("pdftotext"):
            try:
                out = subprocess.run(["pdftotext", "-layout", "-enc", "UTF-8", str(path), "-"], capture_output=True,
                                     timeout=120, stdin=subprocess.DEVNULL)
                if out.returncode == 0:
                    text = out.stdout.decode("utf-8", "replace")
            except (OSError, subprocess.SubprocessError):
                text = None
        if not text or not text.strip():
            try:
                text = extract_pdf_text(path.read_bytes())
            except PdfError as e:
                raise Unsupported(str(e))
        if len(text.strip()) < 20:
            raise Unsupported("This PDF has no readable text (it may be a scan). Add it to your Vault instead.")
        return {"text": text[:MAX_CHARS], "kind": "pdf", "title": title}
    if ext in (".docx", ".docm", ".pptx", ".xlsx", ".xlsm", ".odt", ".odp", ".ods", ".epub"):
        try:
            with zipfile.ZipFile(path) as z:
                text = {".docx": _docx, ".docm": _docx, ".pptx": _pptx, ".xlsx": _xlsx, ".xlsm": _xlsx,
                        ".epub": _epub}.get(ext, _odf)(z)
        except (zipfile.BadZipFile, KeyError, ElementTree.ParseError) as e:
            raise Unsupported(f"Couldn't read this {ext[1:].upper()} file ({e}).")
        if not text.strip():
            raise Unsupported("No text found in this document.")
        return {"text": _clean(text)[:MAX_CHARS], "kind": ext[1:], "title": title}
    if ext in (".html", ".htm", ".xhtml"):
        page = html_to_text(read_text(path, MAX_CHARS * 2))
        return {"text": page["text"][:MAX_CHARS], "kind": "html", "title": page["title"] or title}
    if ext in (".doc", ".xls", ".ppt", ".rtf", ".pages", ".key", ".numbers"):
        raise Unsupported(f"{ext[1:].upper()} files aren't supported. Save it as PDF or DOCX, or add it to your Vault.")
    if ext in TEXT_EXTS or looks_textual(path):
        text = read_text(path, MAX_CHARS)
        if ext == ".ipynb":
            try:
                import json
                nb = json.loads(text)
                text = "\n\n".join(("```python\n" if c.get("cell_type") == "code" else "") + "".join(c.get("source", []))
                                   + ("\n```" if c.get("cell_type") == "code" else "") for c in nb.get("cells", []))
            except ValueError:
                pass
        return {"text": text, "kind": "code" if ext not in (".txt", ".md", ".markdown", ".rst") else "text", "title": title}
    raise Unsupported("This file type can't be read as text. Images and audio can go to Chat or the Playground instead.")
