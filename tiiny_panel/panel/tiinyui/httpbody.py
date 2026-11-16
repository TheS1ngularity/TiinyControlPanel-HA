"""Request bodies for the panel's web server and the gateway: sent with a Content-Length, or in chunks.

Browsers say how long a body is (Content-Length). Clients and reverse proxies that stream a body send it in chunks
instead, without a length (Transfer-Encoding: chunked), and an HTTP/1.1 server has to read those too (RFC 9112,
section 7.1). Reading only by Content-Length took a chunked body as empty, and what was left of it on the connection
as the next request.

The chunks are read strictly, size limits apply while they arrive, and a connection that carried a request with chunks
is closed after the answer (`ClosingHandler`), so nothing left of a body is ever read as a request."""

from __future__ import annotations

import re

from .common import BadRequest

PIECE = 1 << 20           # read at most this much at a time
MAX_SIZE_LINE = 4096      # a chunk's size line with its CRLF, chunk extensions included
MAX_TRAILERS = 16384      # the trailer lines after the last chunk, together
TOO_LARGE = "The request is too large."
_HEX = re.compile(rb"[0-9A-Fa-f]{1,16}")
_CONTROL = re.compile(rb"[\x00-\x08\x0a-\x1f\x7f]")   # control characters other than a tab
_BAD = "The request's chunks aren't valid."
_ENDED = "The request ended before its body did."


class BodyError(BadRequest):
    """A body that can't be read. `status` is the answer: 400, 413 (too large) or 501 (a transfer coding other than
    chunked). `ended` means the client stopped sending partway. The connection must be closed after the answer."""

    def __init__(self, status: int, message: str, ended: bool = False):
        super().__init__(message)
        self.status = status
        self.ended = ended


def framing(headers):
    """How the request's body is sent: ("chunked", None), ("length", n), or ("none", 0) for no body (RFC 9112, 6.3)."""
    encodings = headers.get_all("Transfer-Encoding")
    lengths = headers.get_all("Content-Length")
    if encodings:
        if lengths:   # a broken client, or an attempt to make a proxy and the panel disagree: never pick one
            raise BodyError(400, "A request can't have both a Content-Length and a Transfer-Encoding.")
        codings = [c.strip().lower() for v in encodings for c in v.split(",")]
        if codings == ["chunked"]:
            return "chunked", None
        if all(codings) and codings[-1] == "chunked" and "chunked" not in codings[:-1]:
            raise BodyError(501, "Request bodies can only be sent in plain chunks (Transfer-Encoding: chunked).")
        raise BodyError(400, "The request's Transfer-Encoding isn't valid.")
    if not lengths:
        return "none", 0
    values = {v.strip() for v in ",".join(lengths).split(",")}
    value = values.pop()
    if values or not re.fullmatch(r"[0-9]{1,18}", value):
        raise BodyError(400, "The request's Content-Length isn't valid.")
    return "length", int(value)


def read_body(rfile, headers, limit: int, too_large: str = TOO_LARGE) -> bytes:
    """The request's whole body, at most `limit` bytes. Raises BodyError."""
    kind, length = framing(headers)
    if kind == "length":   # in one read, as before chunks were read
        if length > limit:
            raise BodyError(413, too_large)
        data = rfile.read(length) if length else b""
        if len(data) < length:
            raise BodyError(400, _ENDED, ended=True)
        return data
    return b"".join(iter_body(rfile, headers, limit, too_large))


def iter_body(rfile, headers, limit: int, too_large: str = TOO_LARGE):
    """The request's body in pieces of up to 1 MB, at most `limit` bytes in all. Raises BodyError."""
    kind, length = framing(headers)
    if kind == "length":
        if length > limit:
            raise BodyError(413, too_large)
        yield from _exactly(rfile, length)
    elif kind == "chunked":
        total = 0
        while True:
            size = _chunk_size(rfile)
            if not size:
                break
            total += size
            if total > limit:   # before reading it
                raise BodyError(413, too_large)
            yield from _exactly(rfile, size)
            end = rfile.read(2)
            if end != b"\r\n":
                raise BodyError(400, _BAD if len(end) == 2 else _ENDED, ended=len(end) < 2)
        _skip_trailers(rfile)


def _exactly(rfile, n: int):
    while n:
        part = rfile.read(min(PIECE, n))
        if not part:
            raise BodyError(400, _ENDED, ended=True)
        n -= len(part)
        yield part


def _line(rfile, most: int) -> bytes:
    """One line of at most `most` bytes that ends with CRLF, without the CRLF."""
    line = rfile.readline(most + 1)
    if len(line) > most:
        raise BodyError(400, _BAD)
    if not line.endswith(b"\n"):
        raise BodyError(400, _ENDED, ended=True)
    if not line.endswith(b"\r\n") or _CONTROL.search(line[:-2]):
        raise BodyError(400, _BAD)
    return line[:-2]


def _chunk_size(rfile) -> int:
    """A chunk's size line: hex digits, maybe chunk extensions after a ";" (they're ignored), then CRLF."""
    digits = _line(rfile, MAX_SIZE_LINE).split(b";", 1)[0].rstrip(b" \t")
    if not _HEX.fullmatch(digits):
        raise BodyError(400, _BAD)
    return int(digits, 16)


def _skip_trailers(rfile):
    """The trailer fields after the last chunk, up to an empty line. Nothing in the panel uses them."""
    left = MAX_TRAILERS
    while True:
        line = _line(rfile, left)
        if not line:
            return
        left -= len(line) + 2


class ClosingHandler:
    """Put before BaseHTTPRequestHandler in a request handler's bases. The handler reads bodies through its `read_body`
    and `iter_body`, so it knows whether a request's body was read.
    - A request sent with a transfer coding (in chunks) closes its connection after the answer, whether or not
      anything read its body, so nothing left of it is read as the next request.
    - So does a request whose body (Content-Length) the endpoint didn't read, or didn't read to the end. Left on the
      connection, it would be read as the start of the next request. Behind a proxy that shares its connections to
      the panel between its clients, that next request can be another client's (request smuggling).
    - An answer after which the connection closes says "Connection: close", so a client or proxy doesn't send its
      next request on that connection."""

    _said_connection = False
    _interim = False
    _unread = False   # the request came with a body (Content-Length) that hasn't been read to the end

    def parse_request(self):
        ok = super().parse_request()
        if ok:
            if self.headers.get_all("Transfer-Encoding"):
                self.close_connection = True
            lengths = [v.strip() for v in self.headers.get_all("Content-Length") or []]
            self._unread = bool(lengths) and lengths != ["0"]
        return ok

    def read_body(self, limit: int, too_large: str = TOO_LARGE) -> bytes:
        """The request's whole body, at most `limit` bytes. Raises BodyError, after which the connection closes."""
        try:
            data = read_body(self.rfile, self.headers, limit, too_large)
        except BodyError:
            self.close_connection = True
            raise
        self._unread = False
        return data

    def iter_body(self, limit: int, too_large: str = TOO_LARGE):
        """The request's body in pieces of up to 1 MB, at most `limit` bytes in all. Raises BodyError, as above."""
        try:
            yield from iter_body(self.rfile, self.headers, limit, too_large)
        except BodyError:
            self.close_connection = True
            raise
        self._unread = False

    def send_response_only(self, code, message=None):
        self._interim = 100 <= int(code) < 200   # like "100 Continue": the real answer comes after it
        super().send_response_only(code, message)

    def send_header(self, keyword, value):
        if keyword.lower() == "connection":
            self._said_connection = True
        super().send_header(keyword, value)

    def end_headers(self):
        if not self._interim:
            if self._unread:   # answered without reading the body: close, so what's left of it isn't read as a request
                self.close_connection = True
            if self.close_connection and not self._said_connection:
                super().send_header("Connection", "close")
        self._said_connection = False
        super().end_headers()
