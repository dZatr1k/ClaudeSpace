"""Unix sockets that small helper scripts on the VM use to reach the app through the agent.

askpass.py (sudo password prompts, cclib/askpass.py) and openurl.py ($BROWSER, cclib/openurl.py) connect to a socket
served here, send one JSON line and read one JSON line back. A subclass handles the message (on_message); this class
owns the socket's life.

Security: the socket lives in a 0700 directory of ours (~/.cache/claudespace/run), is 0600, and every peer is
checked with SO_PEERCRED (same uid only). Only an enabled server answers; a disabled one says {"status":
"unavailable"} so the script falls back to what it does without the app.

Several agents (two app windows, an old agent of a dropped connection that sshd has not reaped yet): the newest
enabled agent takes the socket path over atomically (bind a temp name, rename over). An agent whose path was taken
over stops listening and every few seconds probes the holder; when the holder is gone (path missing, connection
refused, or it answers "unavailable"), it takes the path back. On exit an agent removes the path only if it is still
its own socket.

Several apps (the PC and the phone, each with its agent): an agent started with an app id (csagent.py serve --app ID)
also listens on <name>.<ID>.sock, for as long as it runs. The holder of the shared path asks its router (cclib/route.py)
whose request it got: its own app answers here, another app gets {"status": "redirect", "app": ID} and the script
repeats the request on that app's socket, a terminal of no app gets "unavailable". A request on an app's own socket,
or one marked {"routed": true} (the redirect target was gone), is answered without asking again.
"""
import json
import os
import re
import secrets
import socket
import stat
import struct
import threading

from . import paths

MAX_LINE = 16 * 1024
APP_ID = re.compile(r'^[0-9a-f]{16}$')     # csagent.py serve --app ID, the same in CLAUDESPACE_APP of its terminals


def valid_app(v):
    return isinstance(v, str) and bool(APP_ID.match(v))


def run_dir():
    return os.path.join(paths.P.cache, 'run')


class AppSocketError(Exception):
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
        raise AppSocketError(f'{d} is not a directory')
    if st.st_uid != os.getuid():
        raise AppSocketError(f'{d} belongs to another user')
    if st.st_mode & 0o077:
        os.chmod(d, 0o700)
    return d


def peer_cred(conn):
    """(pid, uid, gid) of the process on the other end of a unix socket (Linux SO_PEERCRED)."""
    raw = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
    return struct.unpack('3i', raw)


def send_line(conn, obj):
    try:
        conn.sendall(json.dumps(obj, ensure_ascii=False).encode('utf-8') + b'\n')
    except OSError:
        pass


class AppSocket:
    """name: 'askpass' -> ~/.cache/claudespace/run/askpass.sock (also the log prefix and the thread name)."""

    name = 'appsock'

    def __init__(self, log=lambda *a: None, path=None, app_id=None, router=None):
        self.log = log
        self._path = path
        self.enabled = False
        self.lock = threading.Lock()
        self.sock = None            # our listening socket, while we hold the path
        self.ino = None             # inode of our socket file (to tell whether the path is still ours)
        self.thread = None
        self.app_id = app_id if valid_app(app_id) else None
        self.router = router        # msg -> ('app', id) | ('none', None) | ('any', None), see cclib/route.py
        self.own = None             # (socket, inode) of <name>.<app_id>.sock

    @property
    def path(self):
        return self._path or os.path.join(run_dir(), f'{self.name}.sock')

    def own_path(self, app_id=None):
        """The socket of one app's agent, next to the shared one."""
        return os.path.join(os.path.dirname(self.path), f'{self.name}.{app_id or self.app_id}.sock')

    # -------------------------------------------------------------- to override
    def on_message(self, conn, pid, msg):
        """One request from a script (a dict, already checked: same uid, enabled). Answer with send_line."""
        raise NotImplementedError

    def on_disable(self, reason):
        """The server stops answering (the app turned it off, or the agent exits): end what is waiting."""

    # -------------------------------------------------------------- lifecycle
    def enable(self, on):
        """Start answering (on) or stop and end what is waiting (off)."""
        with self.lock:
            self.enabled = bool(on)
        if on:
            self.check(force=True)
        else:
            self.on_disable('disabled')
            self._stop()
        return self.state()

    def state(self):
        return {'enabled': self.enabled, 'listening': self.sock is not None, 'socket': self.path}

    def check(self, force=False):
        """Periodic (agent loop): keep our app's socket; keep the shared path while enabled. Take it when it is
        missing or its holder is gone, yield when a newer agent took it over. force (just enabled): take it over
        unconditionally."""
        self._keep_own()
        if not self.enabled:
            return
        try:
            st = os.stat(self.path)
        except FileNotFoundError:
            st = None
        except OSError as e:
            self.log(f'{self.name}: stat failed:', e)
            return
        if self.sock is not None:
            if st is not None and st.st_ino == self.ino:
                return
            if st is not None and self._holder_alive():
                self.log(f'{self.name}: socket taken over by another agent')
                self._stop(unlink=False)
                return
        elif st is not None and not force and self._holder_alive():
            return
        try:
            self._bind()
        except (OSError, AppSocketError) as e:
            self.log(f'{self.name}: cannot listen:', e)

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

    def _keep_own(self):
        """Our app's socket exists for as long as the agent runs (disabled, it answers "unavailable")."""
        if self.app_id is None:
            return
        try:
            if self.own is not None and os.stat(self.own_path()).st_ino == self.own[1]:
                return
        except OSError:
            pass
        try:
            s, ino = self._listen(self.own_path(), direct=True)
        except (OSError, AppSocketError) as e:
            self.log(f'{self.name}: cannot listen on the app socket:', e)
            return
        prev, self.own = self.own, (s, ino)
        if prev is not None:
            try:
                prev[0].close()
            except OSError:
                pass

    def _bind(self):
        s, ino = self._listen(self.path, direct=False)
        prev = self.sock
        self.sock, self.ino = s, ino
        if prev is not None:
            try:
                prev.close()
            except OSError:
                pass
        self.log(f'{self.name}: listening on', self.path)

    def _listen(self, path, direct):
        """Bind a temp name, then rename it over path: there is never a moment without a socket."""
        d = ensure_private_dir(os.path.dirname(path))
        tmp = os.path.join(d, f'{self.name}.{os.getpid()}.{secrets.token_hex(3)}.tmp')
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
            os.replace(tmp, path)
            ino = os.stat(path).st_ino
        except OSError:
            s.close()
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        self.thread = threading.Thread(target=self._accept_loop, args=(s, direct), name=self.name, daemon=True)
        self.thread.start()
        return s, ino

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
        """Agent exit (the app is gone): end what is waiting, remove our socket paths."""
        with self.lock:
            self.enabled = False
        self.on_disable('disconnected')
        self._stop()
        own, self.own = self.own, None
        if own is not None:
            try:
                own[0].close()
            except OSError:
                pass
            try:
                if os.stat(self.own_path()).st_ino == own[1]:
                    os.unlink(self.own_path())
            except OSError:
                pass

    # -------------------------------------------------------------- socket side
    def _accept_loop(self, s, direct):
        while s.fileno() != -1:         # until the socket is closed (replaced, stopped, agent exit)
            try:
                conn, _ = s.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=self._serve_conn, args=(conn, direct), name=f'{self.name}-conn',
                             daemon=True).start()

    def _serve_conn(self, conn, direct=False):
        try:
            with conn:
                self._handle(conn, direct)
        except Exception as e:      # never let a bad client take the agent down; never log the payload
            self.log(f'{self.name}: connection failed:', type(e).__name__)

    def _handle(self, conn, direct=False):
        try:
            pid, uid, _gid = peer_cred(conn)
        except OSError:
            return
        if uid != os.getuid():
            self.log(f'{self.name}: refused a peer with uid', uid)
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
            alive = self.enabled and (direct or self.sock is not None)
            send_line(conn, {'status': 'alive' if alive else 'unavailable'})
            return
        if not self.enabled:
            send_line(conn, {'status': 'unavailable'})
            return
        if not direct and self.router is not None and msg.get('routed') is not True:
            try:
                kind, target = self.router(msg)
            except Exception as e:      # routing is a nicety: on any failure answer here, as with one app
                self.log(f'{self.name}: routing failed:', type(e).__name__)
                kind, target = 'any', None
            if kind == 'none':
                self.log(f'{self.name}: the request came from a terminal of no app')
                send_line(conn, {'status': 'unavailable'})
                return
            if kind == 'app' and target != self.app_id and os.path.exists(self.own_path(target)):
                send_line(conn, {'status': 'redirect', 'app': target})
                return
        self.on_message(conn, pid, msg)
