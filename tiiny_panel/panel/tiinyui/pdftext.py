"""Plain-Python PDF text extraction (no dependencies).

Covers what most real PDFs need: Flate/ASCIIHex/ASCII85/LZW/RunLength streams, compressed
object streams, page order from the page tree, ToUnicode CMaps, simple-font encodings with
/Differences, form XObjects, and the Tj / TJ / ' / " text operators with line breaks taken
from text positioning. Scanned PDFs (pages that are only images) have no text to extract,
and encrypted PDFs are reported as such.
"""

from __future__ import annotations

import base64
import re
import zlib

WS = b" \t\r\n\x0c\x00"
DELIMS = b"()<>[]{}/%"
NUM_RE = re.compile(rb"[+-]?(?:\d+\.?\d*|\.\d+)")
KW_RE = re.compile(rb"[A-Za-z*'\"]+|[A-Za-z]+\d*")
OBJ_RE = re.compile(rb"(\d+)\s+(\d+)\s+obj\b")


class PdfError(Exception):
    pass


class _Ref:
    __slots__ = ("num",)

    def __init__(self, num):
        self.num = num


class _Kw(str):
    """An operator or bare keyword in a content stream."""


class _Name(str):
    """A /Name."""


class _Parser:
    def __init__(self, data: bytes):
        self.d = data

    def skip(self, i: int) -> int:
        d, n = self.d, len(self.d)
        while i < n:
            c = d[i]
            if c in WS:
                i += 1
            elif c == 0x25:  # % comment
                while i < n and d[i] not in b"\r\n":
                    i += 1
            else:
                break
        return i

    def parse(self, i: int, depth: int = 0):
        d = self.d
        i = self.skip(i)
        if i >= len(d) or depth > 60:
            return None, len(d)
        c = d[i]
        if d.startswith(b"<<", i):
            return self._dict(i + 2, depth)
        if c == 0x5B:  # [
            return self._array(i + 1, depth)
        if c == 0x28:  # (
            return self._literal(i + 1)
        if c == 0x3C:  # <
            return self._hex(i + 1)
        if c == 0x2F:  # /
            return self._name(i + 1)
        m = NUM_RE.match(d, i)
        if m:
            tok, j = m.group(), m.end()
            if tok.isdigit():
                m2 = re.match(rb"\s+\d+\s+R(?![A-Za-z0-9])", d[j:j + 32])
                if m2:
                    return _Ref(int(tok)), j + m2.end()
            try:
                return (float(tok) if b"." in tok else int(tok)), j
            except ValueError:
                return 0, j
        m = KW_RE.match(d, i)
        if m:
            w = m.group()
            return {b"true": True, b"false": False, b"null": None}.get(w, _Kw(w.decode("latin-1"))), m.end()
        return None, i + 1

    def _dict(self, i, depth):
        out = {}
        d = self.d
        while True:
            i = self.skip(i)
            if i >= len(d):
                return out, i
            if d.startswith(b">>", i):
                return out, i + 2
            key, i = self.parse(i, depth + 1)
            if not isinstance(key, str):
                if key is None and i >= len(d):
                    return out, i
                continue
            val, i = self.parse(i, depth + 1)
            out[str(key)] = val

    def _array(self, i, depth):
        out = []
        d = self.d
        while True:
            i = self.skip(i)
            if i >= len(d):
                return out, i
            if d[i] == 0x5D:  # ]
                return out, i + 1
            val, i = self.parse(i, depth + 1)
            out.append(val)

    def _literal(self, i):
        d, n = self.d, len(self.d)
        out = bytearray()
        level = 1
        while i < n:
            c = d[i]
            if c == 0x5C:  # backslash
                i += 1
                if i >= n:
                    break
                e = d[i]
                if e in b"nrtbf":
                    out.append({0x6E: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12}[e])
                    i += 1
                elif e in b"01234567":
                    j = i
                    while j < n and j < i + 3 and d[j] in b"01234567":
                        j += 1
                    out.append(int(d[i:j], 8) & 0xFF)
                    i = j
                elif e in b"\r\n":  # line continuation
                    i += 1
                    if e == 0x0D and i < n and d[i] == 0x0A:
                        i += 1
                else:
                    out.append(e)
                    i += 1
                continue
            if c == 0x28:
                level += 1
            elif c == 0x29:
                level -= 1
                if level == 0:
                    return bytes(out), i + 1
            out.append(c)
            i += 1
        return bytes(out), i

    def _hex(self, i):
        d = self.d
        j = d.find(b">", i)
        if j == -1:
            j = len(d)
        h = re.sub(rb"[^0-9A-Fa-f]", b"", d[i:j])
        if len(h) % 2:
            h += b"0"
        try:
            return bytes.fromhex(h.decode()), j + 1
        except ValueError:
            return b"", j + 1

    def _name(self, i):
        d, n = self.d, len(self.d)
        j = i
        while j < n and d[j] not in WS and d[j] not in DELIMS:
            j += 1
        raw = re.sub(rb"#([0-9A-Fa-f]{2})", lambda m: bytes([int(m.group(1), 16)]), d[i:j])
        return _Name(raw.decode("latin-1")), j


# ---------------------------------------------------------------------------
# Streams
# ---------------------------------------------------------------------------

def _lzw(data: bytes) -> bytes:
    out, table = bytearray(), [bytes([i]) for i in range(256)] + [b"", b""]
    bits, buf, nbits, prev = 9, 0, 0, None
    for byte in data:
        buf = (buf << 8) | byte
        nbits += 8
        while nbits >= bits:
            nbits -= bits
            code = (buf >> nbits) & ((1 << bits) - 1)
            if code == 256:
                table, bits, prev = table[:258], 9, None
                continue
            if code == 257:
                return bytes(out)
            if code < len(table):
                entry = table[code]
                if prev is not None:
                    table.append(prev + entry[:1])
            elif prev is not None:
                entry = prev + prev[:1]
                table.append(entry)
            else:
                continue
            out += entry
            prev = entry
            if len(table) >= (1 << bits) - 1 and bits < 12:
                bits += 1
    return bytes(out)


def _flate(data: bytes) -> bytes:
    try:
        return zlib.decompress(data)
    except zlib.error:
        d = zlib.decompressobj()
        try:
            return d.decompress(data)
        except zlib.error:
            try:
                return zlib.decompressobj(-15).decompress(data[2:])
            except zlib.error:
                return b""


def _unpredict(data: bytes, parms) -> bytes:
    """PNG predictors (used by xref and object streams)."""
    if not isinstance(parms, dict):
        return data
    pred = parms.get("Predictor", 1)
    if not isinstance(pred, int) or pred < 10:
        return data
    cols = parms.get("Columns", 1) if isinstance(parms.get("Columns"), int) else 1
    bpc = parms.get("BitsPerComponent", 8) if isinstance(parms.get("BitsPerComponent"), int) else 8
    colors = parms.get("Colors", 1) if isinstance(parms.get("Colors"), int) else 1
    bpp = max(1, colors * bpc // 8)
    row_len = (cols * colors * bpc + 7) // 8
    out, prev = bytearray(), bytearray(row_len)
    i = 0
    while i + row_len < len(data) + 1 and i < len(data):
        ft = data[i]
        row = bytearray(data[i + 1:i + 1 + row_len])
        if len(row) < row_len:
            row += bytes(row_len - len(row))
        for x in range(row_len):
            left = row[x - bpp] if x >= bpp else 0
            up = prev[x]
            ul = prev[x - bpp] if x >= bpp else 0
            if ft == 1:
                row[x] = (row[x] + left) & 0xFF
            elif ft == 2:
                row[x] = (row[x] + up) & 0xFF
            elif ft == 3:
                row[x] = (row[x] + ((left + up) >> 1)) & 0xFF
            elif ft == 4:
                p = left + up - ul
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - ul)
                row[x] = (row[x] + (left if pa <= pb and pa <= pc else up if pb <= pc else ul)) & 0xFF
        out += row
        prev = row
        i += 1 + row_len
    return bytes(out)


class _Doc:
    def __init__(self, data: bytes):
        self.data = data
        self.objs = {}
        self.encrypted = b"/Encrypt" in data[-4096:] or bool(re.search(rb"/Encrypt\s+\d+\s+\d+\s+R", data))
        self._load()

    def res(self, v, depth=0):
        while isinstance(v, _Ref) and depth < 32:
            entry = self.objs.get(v.num)
            v = entry[0] if entry else None
            depth += 1
        return v

    def stream(self, num_or_val):
        """Decoded stream bytes for a reference (or None)."""
        if isinstance(num_or_val, _Ref):
            entry = self.objs.get(num_or_val.num)
            if not entry:
                return None
            val, raw = entry
        else:
            return None
        if raw is None or not isinstance(val, dict):
            return None
        return self.decode(val, raw)

    def decode(self, val: dict, raw: bytes):
        filters = self.res(val.get("Filter"))
        parms = self.res(val.get("DecodeParms") or val.get("DP"))
        if filters is None:
            return raw
        if not isinstance(filters, list):
            filters, parms = [filters], [parms]
        elif not isinstance(parms, list):
            parms = [parms] * len(filters)
        data = raw
        for f, p in zip(filters, parms + [None] * (len(filters) - len(parms))):
            f = str(self.res(f))
            p = self.res(p)
            if f in ("FlateDecode", "Fl"):
                data = _unpredict(_flate(data), p)
            elif f in ("ASCIIHexDecode", "AHx"):
                h = re.sub(rb"[^0-9A-Fa-f]", b"", data.split(b">")[0])
                data = bytes.fromhex((h + b"0" * (len(h) % 2)).decode())
            elif f in ("ASCII85Decode", "A85"):
                body = data.strip()
                if body.startswith(b"<~"):
                    body = body[2:]
                body = body.split(b"~>")[0]
                try:
                    data = base64.a85decode(re.sub(rb"\s", b"", body), adobe=False)
                except ValueError:
                    return None
            elif f in ("LZWDecode", "LZW"):
                data = _unpredict(_lzw(data), p)
            elif f in ("RunLengthDecode", "RL"):
                out, i = bytearray(), 0
                while i < len(data):
                    n = data[i]
                    if n == 128:
                        break
                    if n < 128:
                        out += data[i + 1:i + 2 + n]
                        i += n + 2
                    else:
                        out += data[i + 1:i + 2] * (257 - n)
                        i += 2
                data = bytes(out)
            else:  # image codecs (DCT, JPX, CCITT, JBIG2): no text here
                return None
        return data

    def _load(self):
        d = self.data
        p = _Parser(d)
        skip_until = 0
        for m in OBJ_RE.finditer(d):
            if m.start() < skip_until:
                continue
            num = int(m.group(1))
            try:
                val, j = p.parse(m.end())
            except (RecursionError, ValueError, IndexError):
                continue
            raw = None
            k = p.skip(j)
            if d.startswith(b"stream", k):
                k += 6
                if d[k:k + 2] == b"\r\n":
                    k += 2
                elif d[k:k + 1] in (b"\n", b"\r"):
                    k += 1
                length = val.get("Length") if isinstance(val, dict) else None
                if isinstance(length, int) and 0 <= length and d[k + length:k + length + 32].lstrip().startswith(b"endstream"):
                    raw = d[k:k + length]
                    skip_until = k + length
                else:
                    e = d.find(b"endstream", k)
                    e = len(d) if e == -1 else e
                    raw = d[k:e]
                    if raw.endswith(b"\r\n"):
                        raw = raw[:-2]
                    elif raw.endswith((b"\n", b"\r")):
                        raw = raw[:-1]
                    skip_until = e
            self.objs[num] = (val, raw)
        # objects packed inside object streams
        for num, (val, raw) in list(self.objs.items()):
            if not (isinstance(val, dict) and val.get("Type") == "ObjStm" and raw is not None):
                continue
            data = self.decode(val, raw)
            first, n = val.get("First"), val.get("N")
            if not data or not isinstance(first, int) or not isinstance(n, int):
                continue
            header = re.findall(rb"\d+", data[:first])
            sp = _Parser(data)
            for idx in range(min(n, len(header) // 2)):
                onum, off = int(header[2 * idx]), int(header[2 * idx + 1])
                if onum in self.objs:
                    continue
                try:
                    v, _ = sp.parse(first + off)
                except (RecursionError, ValueError, IndexError):
                    continue
                self.objs[onum] = (v, None)

    def pages(self):
        catalog = None
        for _num, (val, _raw) in self.objs.items():
            if isinstance(val, dict) and val.get("Type") == "Catalog":
                catalog = val
        out, seen = [], set()

        def walk(node_ref, inherited, depth):
            if depth > 50:
                return
            if isinstance(node_ref, _Ref):
                if node_ref.num in seen:
                    return
                seen.add(node_ref.num)
            node = self.res(node_ref)
            if not isinstance(node, dict):
                return
            resources = node.get("Resources", inherited)
            kids = self.res(node.get("Kids"))
            if isinstance(kids, list):
                for k in kids:
                    walk(k, resources, depth + 1)
            elif node.get("Type") == "Page" or "Contents" in node:
                out.append((node, self.res(resources)))

        if catalog:
            walk(catalog.get("Pages"), None, 0)
        if not out:
            for num in sorted(self.objs):
                val = self.objs[num][0]
                if isinstance(val, dict) and val.get("Type") == "Page":
                    out.append((val, self.res(val.get("Resources"))))
        return out


# ---------------------------------------------------------------------------
# Fonts
# ---------------------------------------------------------------------------

GLYPHS = {
    "space": " ", "exclam": "!", "quotedbl": '"', "numbersign": "#", "dollar": "$", "percent": "%", "ampersand": "&",
    "quotesingle": "'", "quoteright": "’", "quoteleft": "‘", "parenleft": "(", "parenright": ")", "asterisk": "*",
    "plus": "+", "comma": ",", "hyphen": "-", "minus": "−", "period": ".", "slash": "/", "colon": ":", "semicolon": ";",
    "less": "<", "equal": "=", "greater": ">", "question": "?", "at": "@", "bracketleft": "[", "backslash": "\\",
    "bracketright": "]", "asciicircum": "^", "underscore": "_", "grave": "`", "braceleft": "{", "bar": "|",
    "braceright": "}", "asciitilde": "~", "bullet": "•", "endash": "–", "emdash": "—", "quotedblleft": "“",
    "quotedblright": "”", "quotesinglbase": "‚", "quotedblbase": "„", "ellipsis": "…", "dagger": "†",
    "daggerdbl": "‡", "fi": "fi", "fl": "fl", "ff": "ff", "ffi": "ffi", "ffl": "ffl", "copyright": "©",
    "registered": "®", "trademark": "™", "degree": "°", "section": "§", "paragraph": "¶", "periodcentered": "·",
    "guillemotleft": "«", "guillemotright": "»", "nbspace": " ", "sfthyphen": "-", "Euro": "€", "sterling": "£",
    "yen": "¥", "cent": "¢", "multiply": "×", "divide": "÷", "plusminus": "±", "mu": "µ", "germandbls": "ß",
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7",
    "eight": "8", "nine": "9", "dotlessi": "ı", "circumflex": "^", "tilde": "~", "acute": "´", "dieresis": "¨",
}
_ACCENTS = {"acute": "́", "grave": "̀", "circumflex": "̂", "tilde": "̃", "dieresis": "̈",
            "ring": "̊", "cedilla": "̧", "caron": "̌", "slash": "̸"}


def _glyph(name: str) -> str:
    if name in GLYPHS:
        return GLYPHS[name]
    if len(name) == 1:
        return name
    m = re.fullmatch(r"uni([0-9A-Fa-f]{4})+", name)
    if m:
        return "".join(chr(int(name[3 + 4 * i:7 + 4 * i], 16)) for i in range((len(name) - 3) // 4))
    m = re.fullmatch(r"u([0-9A-Fa-f]{4,6})", name)
    if m:
        try:
            return chr(int(m.group(1), 16))
        except ValueError:
            return ""
    base = name.split(".")[0].split("_")[0]
    if base != name:
        return _glyph(base)
    for acc, comb in _ACCENTS.items():  # e.g. eacute -> é
        if name.endswith(acc) and len(name) == len(acc) + 1:
            import unicodedata
            return unicodedata.normalize("NFC", name[0] + comb)
    return ""


def _parse_cmap(data: bytes):
    mapping, widths = {}, set()

    def u16(h: bytes) -> str:
        b = bytes.fromhex(h.decode())
        try:
            return b.decode("utf-16-be")
        except UnicodeDecodeError:
            return ""

    for sec in re.findall(rb"begincodespacerange(.*?)endcodespacerange", data, re.S):
        for lo, _hi in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", sec):
            widths.add(len(lo) // 2)
    for sec in re.findall(rb"beginbfchar(.*?)endbfchar", data, re.S):
        for src, dst in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>", sec):
            mapping[(len(src) // 2, int(src, 16))] = u16(dst)
            widths.add(len(src) // 2)
    for sec in re.findall(rb"beginbfrange(.*?)endbfrange", data, re.S):
        for lo, hi, rest in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f]*>)", sec):
            w = len(lo) // 2
            widths.add(w)
            a, b = int(lo, 16), int(hi, 16)
            if b - a > 65535:
                continue
            if rest.startswith(b"["):
                for k, h in enumerate(re.findall(rb"<([0-9A-Fa-f]*)>", rest)):
                    if a + k <= b:
                        mapping[(w, a + k)] = u16(h)
            else:
                dst = rest[1:-1]
                if not dst:
                    continue
                base = int(dst, 16)
                nb = len(dst) // 2
                for k in range(b - a + 1):
                    try:
                        mapping[(w, a + k)] = u16(format(base + k, f"0{nb * 2}x").encode())
                    except ValueError:
                        break
    return mapping, sorted(widths or {1}, reverse=True)


class _Font:
    def __init__(self, doc: _Doc, fdict):
        fdict = doc.res(fdict) if fdict is not None else {}
        self.cmap, self.widths = None, [1]
        self.two_byte = isinstance(fdict, dict) and fdict.get("Subtype") == "Type0"
        self.table = {}
        if not isinstance(fdict, dict):
            return
        tu = fdict.get("ToUnicode")
        if isinstance(tu, _Ref):
            data = doc.stream(tu)
            if data:
                self.cmap, self.widths = _parse_cmap(data)
        if self.two_byte and self.widths == [1]:
            self.widths = [2]
        enc = doc.res(fdict.get("Encoding"))
        base = "cp1252"
        diffs = None
        if isinstance(enc, str):
            base = {"MacRomanEncoding": "mac_roman"}.get(enc, "cp1252")
        elif isinstance(enc, dict):
            base = {"MacRomanEncoding": "mac_roman"}.get(str(doc.res(enc.get("BaseEncoding")) or ""), "cp1252")
            diffs = doc.res(enc.get("Differences"))
        for code in range(256):
            try:
                self.table[code] = bytes([code]).decode(base)
            except UnicodeDecodeError:
                self.table[code] = ""
        if isinstance(diffs, list):
            code = 0
            for item in diffs:
                item = doc.res(item)
                if isinstance(item, int):
                    code = item
                elif isinstance(item, str):
                    if 0 <= code < 256:
                        self.table[code] = _glyph(str(item))
                    code += 1

    def decode(self, b: bytes) -> str:
        if self.cmap is not None:
            out, i, n = [], 0, len(b)
            while i < n:
                for w in self.widths:
                    if i + w <= n and (w, int.from_bytes(b[i:i + w], "big")) in self.cmap:
                        out.append(self.cmap[(w, int.from_bytes(b[i:i + w], "big"))])
                        i += w
                        break
                else:
                    i += self.widths[-1] if not self.two_byte else 2
            return "".join(out)
        if self.two_byte:
            try:
                s = b.decode("utf-16-be")
                return s if s.isprintable() else ""
            except UnicodeDecodeError:
                return ""
        return "".join(self.table.get(c, "") for c in b)


# ---------------------------------------------------------------------------
# Content streams
# ---------------------------------------------------------------------------

def _page_text(doc: _Doc, content: bytes, resources, depth: int = 0) -> str:
    resources = doc.res(resources) if resources is not None else {}
    resources = resources if isinstance(resources, dict) else {}
    font_dict = doc.res(resources.get("Font")) or {}
    xobjects = doc.res(resources.get("XObject")) or {}
    fonts = {}
    p = _Parser(content)
    lines, cur = [], []
    font = None
    operands = []
    last_y = None
    i, n = 0, len(content)

    def newline():
        nonlocal cur
        lines.append("".join(cur).rstrip())
        cur = []

    def space():
        if cur and not cur[-1].endswith((" ", "\n")):
            cur.append(" ")

    def show(s):
        if isinstance(s, bytes):
            cur.append(font.decode(s) if font else s.decode("latin-1"))

    while i < n:
        try:
            tok, i = p.parse(i)
        except (RecursionError, ValueError, IndexError):
            break
        if not isinstance(tok, _Kw):
            if tok is not None or i < n:
                operands.append(tok)
            continue
        op = str(tok)
        if op == "Tf" and len(operands) >= 2:
            name = str(operands[-2])
            if name not in fonts:
                fonts[name] = _Font(doc, font_dict.get(name) if isinstance(font_dict, dict) else None)
            font = fonts[name]
        elif op in ("Td", "TD") and len(operands) >= 2:
            tx, ty = operands[-2], operands[-1]
            if isinstance(ty, (int, float)) and abs(ty) > 0.5:
                newline()
            elif isinstance(tx, (int, float)) and tx > 1:
                space()
        elif op == "Tm" and len(operands) >= 6:
            y = operands[5]
            if isinstance(y, (int, float)):
                if last_y is not None and abs(y - last_y) > 0.5:
                    newline()
                elif last_y is not None:
                    space()
                last_y = y
        elif op == "T*":
            newline()
        elif op == "Tj" and operands:
            show(operands[-1])
        elif op in ("'", '"') and operands:
            newline()
            show(operands[-1])
        elif op == "TJ" and operands and isinstance(operands[-1], list):
            for el in operands[-1]:
                if isinstance(el, bytes):
                    show(el)
                elif isinstance(el, (int, float)) and el < -180:
                    space()
        elif op == "ET":
            space()
        elif op == "BI":  # skip inline image data
            j = content.find(b"ID", i)
            e = content.find(b"EI", j + 2) if j != -1 else -1
            while e != -1 and not (content[e - 1:e] in (b" ", b"\n", b"\r") and content[e + 2:e + 3] in (b"", b" ", b"\n", b"\r")):
                e = content.find(b"EI", e + 2)
            i = len(content) if e == -1 else e + 2
        elif op == "Do" and operands and depth < 3 and isinstance(xobjects, dict):
            ref = xobjects.get(str(operands[-1]))
            xo = doc.res(ref)
            if isinstance(xo, dict) and xo.get("Subtype") == "Form" and isinstance(ref, _Ref):
                data = doc.stream(ref)
                if data:
                    sub = _page_text(doc, data, xo.get("Resources", resources), depth + 1)
                    if sub.strip():
                        newline()
                        lines.append(sub)
        operands = []
    newline()
    return "\n".join(lines)


def _tidy(text: str) -> str:
    text = text.replace(" ", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)  # re-join hyphenated words
    text = "\n".join(l.strip() for l in text.split("\n"))
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def extract_pdf_text(data: bytes, max_pages: int = 1000) -> str:
    if not data.startswith(b"%PDF"):
        head = data[:1024]
        if b"%PDF" not in head:
            raise PdfError("This doesn't look like a PDF file.")
    doc = _Doc(data)
    if doc.encrypted:
        raise PdfError("This PDF is encrypted, so its text can't be read.")
    pages = doc.pages()
    if not pages:
        raise PdfError("No pages found in this PDF.")
    out = []
    for node, resources in pages[:max_pages]:
        contents = node.get("Contents")
        refs = doc.res(contents) if not isinstance(contents, _Ref) else contents
        refs = refs if isinstance(refs, list) else [contents]
        chunks = []
        for r in refs:
            data_ = doc.stream(r) if isinstance(r, _Ref) else None
            if data_:
                chunks.append(data_)
        text = _page_text(doc, b"\n".join(chunks), resources) if chunks else ""
        out.append(_tidy(text))
    return "\n\n".join(t for t in out if t)
