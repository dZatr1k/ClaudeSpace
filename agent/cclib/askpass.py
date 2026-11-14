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

Security: the socket lives in a 0700 directory of ours (~/.cache/claudespace/run), is 0600, and every peer is
checked with SO_PEERCRED (same uid only). The password is never logged and is dropped as soon as it is written to
the script. Only the app (enable(True) after it connected and the setting is on) makes the socket answer at all.

Several agents (two app windows, an old agent of a dropped connection that sshd has not reaped yet): the newest
enabled agent takes the socket path over atomically (bind a temp name, rename over). An agent whose path was taken
over stops listening and every few seconds probes the holder; when the holder is gone (path missing, connection
refused, or it answers "unavailable"), it takes the path back. On exit an agent removes the path only if it is still
its own socket.
"""
import json
import os
import secrets
import select
import socket
import stat
import struct
import threading
import time

from . import paths

TIMEOUT = 120.0
MAX_PENDING = 8
MAX_LINE = 16 * 1024
MAX_PASSWORD = 1024
SOCK_NAME = 'askpass.sock'
ID_CHARS = set('0123456789abcdef')


def run_dir():
    return os.path.join(paths.P.cache, 'run')


def sock_path():
    return os.path.join(run_dir(), SOCK_NAME)


class AskpassError(Exception):
    pass


def ensure_private_dir(d):
    """mkdir -m 700 (with parents); refuse a symlink or a directory of another user; tighten our own to 0700."""
    os.makedirs(os.path.dirname(d), exist_ok=True)
    try:
        os.mkdir(d, 0o700)
    except FileExistsError:
        pass
    st = os.lstat(d)
    if not stat.S_ISDIR(st.st_mode):
        raise AskpassError(f'{d} is not a directory')
    if st.st_uid != os.getuid():
        raise AskpassError(f'{d} belongs to another user')
    if st.st_mode & 0o077:
        os.chmod(d, 0o700)
    return d


def _clean_text(v, limit):
    if not isinstance(v, str):
        return None
    v = ''.join(ch if ch >= ' ' or ch in '\t' else ' ' for ch in v).strip()
    return v[:limit] or None


def peer_cred(conn):
    """(pid, uid, gid) of the process on the other end of a unix socket (Linux SO_PEERCRED)."""
    raw = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
    return struct.unpack('3i', raw)


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


class AskpassServer:
    """emit(event, data) sends to the app; session_of(pane) maps a tmux pane id (%3) to its session name."""

    def __init__(self, emit, session_of=lambda pane: None, log=lambda *a: None, timeout=TIMEOUT, path=None):
        self.emit = emit
        self.session_of = session_of
        self.log = log
        self.timeout = timeout
        self._path = path
        self.enabled = False
        self.lock = threading.Lock()
        self.pending = {}           # id -> _Pending
        self.sock = None            # our listening socket, while we hold the path
        self.ino = None             # inode of our socket file (to tell whether the path is still ours)
        self.thread = None

    @property
    def path(self):
        return self._path or sock_path()

    # -------------------------------------------------------------- lifecycle
    def enable(self, on):
        """Called by the app: start answering prompts (on) or stop and cancel what is waiting (off)."""
        with self.lock:
            self.enabled = bool(on)
        if on:
            self.check(force=True)
        else:
            self.cancel_all('disabled')
            self._stop()
        return self.state()

    def state(self):
        return {'enabled': self.enabled, 'listening': self.sock is not None, 'socket': self.path}

    def check(self, force=False):
        """Periodic (agent loop): keep the socket path while enabled — take it when it is missing or its holder is gone,
        yield when a newer agent took it over. force (the app just enabled us): take it over unconditionally."""
        if not self.enabled:
            return
        try:
            st = os.stat(self.path)
        except FileNotFoundError:
            st = None
        except OSError as e:
            self.log('askpass: stat failed:', e)
            return
        if self.sock is not None:
            if st is not None and st.st_ino == self.ino:
                return
            if st is not None and self._holder_alive():
                self.log('askpass: socket taken over by another agent')
                self._stop(unlink=False)
                return
        elif st is not None and not force and self._holder_alive():
            return
        try:
            self._bind()
        except (OSError, AskpassError) as e:
            self.log('askpass: cannot listen:', e)

    def _holder_alive(self):
        """Does the socket at our path answer like an enabled agent?"""
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
                s.settimeout(1.0)
                s.connect(self.path)
                s.sendall(b'{"probe":true}\n')
                buf = b''
                while b'\n' not in buf and len(buf) < 256:
                    chunk = s.recv(256)
                    if not chunk:
                        break
                    buf += chunk
            return json.loads(buf.decode('utf-8', 'replace') or '{}').get('status') == 'alive'
        except (OSError, ValueError):
            return False

    def _bind(self):
        d = ensure_private_dir(run_dir() if self._path is None else os.path.dirname(self._path))
        tmp = os.path.join(d, f'askpass.{os.getpid()}.{secrets.token_hex(3)}.sock')
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        old = os.umask(0o177)
        try:
            s.bind(tmp)
        finally:
            os.umask(old)
        try:
            os.chmod(tmp, 0o600)
            s.listen(16)
            s.settimeout(1.0)
            os.replace(tmp, self.path)         # atomic take-over: there is never a moment without a socket
            ino = os.stat(self.path).st_ino
        except OSError:
            s.close()
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        prev = self.sock
        self.sock, self.ino = s, ino
        if prev is not None:
            try:
                prev.close()
            except OSError:
                pass
        self.thread = threading.Thread(target=self._accept_loop, args=(s,), name='askpass', daemon=True)
        self.thread.start()
        self.log('askpass: listening on', self.path)

    def _stop(self, unlink=True):
        s, ino = self.sock, self.ino
        self.sock, self.ino = None, None
        if s is None:
            return
        try:
            s.close()
        except OSError:
            pass
        if unlink:
            try:
                if os.stat(self.path).st_ino == ino:
                    os.unlink(self.path)
            except OSError:
                pass

    def shutdown(self):
        """Agent exit (the app is gone): every waiting script exits 1, our socket path is removed."""
        with self.lock:
            self.enabled = False
        self.cancel_all('disconnected')
        self._stop()

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
    def _accept_loop(self, s):
        while self.sock is s:
            try:
                conn, _ = s.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=self._serve_conn, args=(conn,), name='askpass-conn', daemon=True).start()

    def _serve_conn(self, conn):
        try:
            with conn:
                self._handle(conn)
        except Exception as e:      # never let a bad client take the agent down; never log the payload
            self.log('askpass: connection failed:', type(e).__name__)

    @staticmethod
    def _send(conn, obj):
        try:
            conn.sendall(json.dumps(obj, ensure_ascii=False).encode('utf-8') + b'\n')
        except OSError:
            pass

    def _handle(self, conn):
        try:
            pid, uid, _gid = peer_cred(conn)
        except OSError:
            return
        if uid != os.getuid():
            self.log('askpass: refused a peer with uid', uid)
            return
        conn.settimeout(5.0)
        buf = b''
        while b'\n' not in buf:
            chunk = conn.recv(4096)
            if not chunk:
                return
            buf += chunk
            if len(buf) > MAX_LINE:
                return
        try:
            msg = json.loads(buf.split(b'\n', 1)[0].decode('utf-8', 'replace'))
        except ValueError:
            return
        if not isinstance(msg, dict):
            return
        if msg.get('probe') is True:
            self._send(conn, {'status': 'alive' if self.enabled and self.sock is not None else 'unavailable'})
            return
        if not self.enabled:
            self._send(conn, {'status': 'unavailable'})
            return
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
