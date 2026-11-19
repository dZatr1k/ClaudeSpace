"""sudo password prompts in the app (BACKLOG 11): the unix-socket side of askpass.py.

`sudo -A` runs $SUDO_ASKPASS; when that is ClaudeSpace's askpass.py, the script connects to the socket served here,
sends one JSON line {v, prompt, pane, command, cwd}, and waits for one JSON line back:
  {"status": "ok", "password": "..."}  -> prints it for sudo, exit 0
  {"status": "cancel" | "timeout" | "busy"} -> exit 1 (sudo aborts)
  {"status": "unavailable"}            -> no app is listening: the script falls back to the GTK prompt
  {"status": "alive"}                  -> answer to {"probe": true} (another agent checking who holds the socket)

The agent emits `askpass_request` {id, prompt, command, cwd, session, at} to the app and waits for `askpass_reply`
(method) for up to TIMEOUT seconds; `askpass_done` {id, reason} tells the app a prompt is over without its answer
(timeout, sudo was interrupted, the app turned the feature off).

The socket itself (0700 directory, 0600 socket, same-uid peers only, several agents taking the path over) is
cclib/appsock.py. The password is never logged and is dropped as soon as it is written to the script. Only the app
(enable(True) after it connected and the setting is on) makes the socket answer at all.
"""
import os
import secrets
import select
import socket
import threading
import time

from . import appsock
from .appsock import MAX_LINE, AppSocketError as AskpassError, ensure_private_dir, run_dir  # noqa: F401

TIMEOUT = 120.0
MAX_PENDING = 8
MAX_PASSWORD = 1024
SOCK_NAME = 'askpass.sock'
ID_CHARS = set('0123456789abcdef')


def sock_path():
    return os.path.join(run_dir(), SOCK_NAME)


def _clean_text(v, limit):
    if not isinstance(v, str):
        return None
    v = ''.join(ch if ch >= ' ' or ch in '\t' else ' ' for ch in v).strip()
    return v[:limit] or None


def proc_parent_cmdline(pid):
    """Command line of the parent of pid (askpass.py's parent is sudo): what asks for root."""
    try:
        with open(f'/proc/{pid}/stat', 'rb') as f:
            ppid = int(f.read().rsplit(b')', 1)[1].split()[1])
        with open(f'/proc/{ppid}/cmdline', 'rb') as f:
            raw = f.read(8192)
        return raw.rstrip(b'\0').replace(b'\0', b' ').decode('utf-8', 'replace').strip() or None
    except (OSError, ValueError, IndexError):
        return None


def proc_cwd(pid):
    try:
        return os.readlink(f'/proc/{pid}/cwd')
    except OSError:
        return None


def valid_id(rid):
    return isinstance(rid, str) and len(rid) == 16 and set(rid) <= ID_CHARS


class _Pending:
    __slots__ = ('event', 'password', 'answered', 'reason')

    def __init__(self):
        self.event = threading.Event()
        self.password = None
        self.answered = False
        self.reason = 'answered'


class AskpassServer(appsock.AppSocket):
    """emit(event, data) sends to the app; session_of(pane) maps a tmux pane id (%3) to its session name."""

    name = 'askpass'

    def __init__(self, emit, session_of=lambda pane: None, log=lambda *a: None, timeout=TIMEOUT, path=None):
        super().__init__(log=log, path=path)
        self.emit = emit
        self.session_of = session_of
        self.timeout = timeout
        self.pending = {}           # id -> _Pending

    @property
    def path(self):
        return self._path or sock_path()

    def on_disable(self, reason):
        """disabled by the app, or the agent exits: every waiting script exits 1 (sudo aborts)."""
        self.cancel_all(reason)

    # -------------------------------------------------------------- app side
    def reply(self, rid, password):
        """askpass_reply from the app. password None = cancel. Returns False if there is no such prompt (any more)."""
        with self.lock:
            p = self.pending.get(rid)
            if p is None or p.answered:
                return False
            p.password = password
            p.answered = True
        p.event.set()
        return True

    def cancel_all(self, reason):
        with self.lock:
            items = list(self.pending.items())
            for _, p in items:
                if not p.answered:
                    p.password, p.answered, p.reason = None, True, reason
        for rid, p in items:
            p.event.set()
        return [rid for rid, _ in items]

    # -------------------------------------------------------------- socket side
    @staticmethod
    def _send(conn, obj):
        appsock.send_line(conn, obj)

    def on_message(self, conn, pid, msg):
        pane = msg.get('pane')
        pane = pane if isinstance(pane, str) and len(pane) < 16 and pane.startswith('%') else None
        rid = secrets.token_hex(8)
        p = _Pending()
        with self.lock:
            if len(self.pending) >= MAX_PENDING:
                busy = True
            else:
                busy = False
                self.pending[rid] = p
        if busy:
            self._send(conn, {'status': 'busy'})
            return
        try:
            session = None
            if pane:
                try:
                    session = self.session_of(pane)
                except Exception:
                    session = None
            req = {
                'id': rid,
                'prompt': _clean_text(msg.get('prompt'), 200) or 'Password:',
                # what asks for root: our own look at the peer's parent (sudo), else what the script says
                'command': _clean_text(proc_parent_cmdline(pid) or msg.get('command'), 2000),
                'cwd': _clean_text(proc_cwd(pid) or msg.get('cwd'), 4096),
                'session': session,
                'at': int(time.time() * 1000),
            }
            self.emit('askpass_request', req)
            self.log('askpass: request', rid, 'session', session or '-')
            reason = self._wait(conn, p)
            if reason == 'answered':
                pw = p.password
                p.password = None
                if pw is None:
                    self._send(conn, {'status': 'cancel'})
                    self.log('askpass:', rid, 'cancelled')
                else:
                    self._send(conn, {'status': 'ok', 'password': pw})
                    del pw
                    self.log('askpass:', rid, 'answered')
            else:
                self._send(conn, {'status': 'timeout' if reason == 'timeout' else 'cancel'})
                self.emit('askpass_done', {'id': rid, 'reason': reason})
                self.log('askpass:', rid, reason)
        finally:
            with self.lock:
                self.pending.pop(rid, None)
            p.password = None

    def _wait(self, conn, p):
        """Wait for the app's answer; notice when the script goes away (sudo interrupted) or time runs out."""
        end = time.time() + self.timeout
        while True:
            if p.event.wait(0.2):
                return p.reason
            if time.time() >= end:
                with self.lock:
                    if p.answered:
                        continue
                    p.answered = True
                return 'timeout'
            try:
                r, _, _ = select.select([conn], [], [], 0)
                if r and not conn.recv(1, socket.MSG_PEEK):
                    with self.lock:
                        if p.answered:
                            continue
                        p.answered = True
                    return 'gone'
            except OSError:
                return 'gone'
