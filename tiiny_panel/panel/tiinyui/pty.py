"""Pseudo-terminal sessions, so interactive tiiny commands work in the page."""

from __future__ import annotations

import fcntl
import os
import secrets
import select
import signal
import struct
import termios
import threading
import time
import warnings

from .clitools import display_cmd
from .common import BadRequest


def _exit_code(status: int) -> int:
    """A wait() status as an exit code (negative for a signal). os.waitstatus_to_exitcode only exists from Python 3.9."""
    if hasattr(os, "waitstatus_to_exitcode"):
        return os.waitstatus_to_exitcode(status)
    if os.WIFSIGNALED(status):
        return -os.WTERMSIG(status)
    return os.WEXITSTATUS(status)

PTY_BUFFER_LIMIT = 4 * 1024 * 1024
MAX_PTY_SESSIONS = 12


def _set_winsize(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def spawn_in_pty(argv, env, cwd, cols, rows):
    master, slave = os.openpty()
    _set_winsize(slave, rows, cols)
    with warnings.catch_warnings():
        # Python warns about fork() in threaded programs; the child execs straight away.
        warnings.simplefilter("ignore", DeprecationWarning)
        pid = os.fork()
    if pid == 0:  # child
        try:
            os.close(master)
            if hasattr(os, "login_tty"):
                os.login_tty(slave)
            else:
                os.setsid()
                fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
                for fd in (0, 1, 2):
                    os.dup2(slave, fd)
                if slave > 2:
                    os.close(slave)
            os.chdir(cwd)
            os.execve(argv[0], argv, env)
        except BaseException as e:  # noqa: BLE001 - must never return into the server
            try:
                os.write(2, f"Failed to start {argv[0]}: {e}\r\n".encode())
            except OSError:
                pass
        os._exit(127)
    os.close(slave)
    os.set_blocking(master, False)
    return pid, master


class PtySession:
    def __init__(self, argv, env, cwd, cols, rows):
        self.id = secrets.token_urlsafe(9)
        self.cmd = display_cmd(argv)
        self.started = time.time()
        self.ended = None
        self.code = None
        self.buf = bytearray()
        self.base = 0  # stream offset of buf[0]
        self.cond = threading.Condition()
        self.fd_lock = threading.Lock()
        self.pid, self.fd = spawn_in_pty(argv, env, cwd, cols, rows)
        threading.Thread(target=self._pump, daemon=True, name=f"pty-{self.id}").start()

    @property
    def running(self):
        return self.ended is None

    def _append(self, data: bytes):
        with self.cond:
            self.buf += data
            excess = len(self.buf) - PTY_BUFFER_LIMIT
            if excess > 0:
                del self.buf[:excess]
                self.base += excess
            self.cond.notify_all()

    def _read_available(self):
        """Bytes read, b"" at end of output, or None when nothing is ready yet."""
        try:
            return os.read(self.fd, 65536)
        except BlockingIOError:
            return None
        except OSError:  # EIO once every slave fd is closed
            return b""

    def _pump(self):
        status = None
        while True:
            try:
                ready, _, _ = select.select([self.fd], [], [], 0.5)
            except (OSError, ValueError):
                break
            if ready:
                data = self._read_available()
                if data is None:
                    continue
                if not data:
                    break
                self._append(data)
                continue
            try:
                pid, st = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                break
            if pid:
                status = st
                while True:  # drain what is still buffered
                    data = self._read_available()
                    if not data:
                        break
                    self._append(data)
                break
        if status is None:
            try:
                _, status = os.waitpid(self.pid, 0)
            except ChildProcessError:
                status = None
        with self.fd_lock:
            try:
                os.close(self.fd)
            except OSError:
                pass
            self.fd = -1
        with self.cond:
            self.code = _exit_code(status) if status is not None else None
            self.ended = time.time()
            self.cond.notify_all()

    def read(self, offset: int, timeout: float):
        with self.cond:
            end = self.base + len(self.buf)
            if offset >= end and self.ended is None:
                self.cond.wait(timeout)
                end = self.base + len(self.buf)
            offset = max(offset, self.base)
            return end, bytes(self.buf[offset - self.base:]), self.ended is not None

    def write(self, data: bytes):
        deadline = time.time() + 3
        with self.fd_lock:
            if self.fd < 0:
                raise BadRequest("The command has already finished.")
            view = memoryview(data)
            while view:
                try:
                    n = os.write(self.fd, view)
                    view = view[n:]
                except BlockingIOError:
                    if time.time() > deadline:
                        raise BadRequest("The program isn't reading input right now.")
                    time.sleep(0.01)
                except OSError:
                    raise BadRequest("The command has already finished.")

    def resize(self, cols, rows):
        with self.fd_lock:
            if self.fd >= 0:
                _set_winsize(self.fd, rows, cols)

    def kill(self, gentle=True):
        steps = ((signal.SIGHUP, 0.6), (signal.SIGTERM, 1.5), (signal.SIGKILL, 0)) if gentle else ((signal.SIGKILL, 0),)
        for sig, wait in steps:
            if self.ended is not None:
                return
            try:
                os.killpg(self.pid, sig)
            except (ProcessLookupError, PermissionError):
                return
            deadline = time.time() + wait
            while time.time() < deadline and self.ended is None:
                time.sleep(0.05)

    def info(self):
        return {"id": self.id, "cmd": self.cmd, "running": self.running, "code": self.code, "started": self.started}


class PtyManager:
    def __init__(self):
        self.sessions = {}
        self.lock = threading.Lock()

    def start(self, argv, env, cwd, cols, rows):
        with self.lock:
            now = time.time()
            for sid, s in list(self.sessions.items()):
                if s.ended and now - s.ended > 1800:
                    del self.sessions[sid]
            if sum(1 for s in self.sessions.values() if s.running) >= MAX_PTY_SESSIONS:
                raise BadRequest("Too many terminal sessions are running. Close some first.")
            s = PtySession(argv, env, cwd, cols, rows)
            self.sessions[s.id] = s
            return s

    def get(self, sid):
        with self.lock:
            return self.sessions.get(sid)

    def all(self):
        with self.lock:
            return list(self.sessions.values())

    def kill_all(self):
        for s in self.all():
            s.kill(gentle=False)
