"""Which app a helper script's request is for, when several apps use the VM at once (the PC, the phone, a dev copy).

Every app starts its agent with its own id (csagent.py serve --app ID, 16 hex digits, new on every connection) and
exports CLAUDESPACE_APP=ID in the terminals it opens: in the tmux clients it attaches and in plain shells. The agent
whose socket a script reached (cclib/appsock.py) asks route() where the request belongs:
- the script runs in tmux (it sends $TMUX and $TMUX_PANE): the client attached to that pane's session with the latest
  activity decides. That is the client the user typed or clicked in, so a sudo prompt or a link goes where the user
  is looking. A client without CLAUDESPACE_APP (`cc` over plain SSH, say) means the request is for no app at all;
- the script runs outside tmux: its own $CLAUDESPACE_APP (a plain shell tab of that app);
- nobody watches that session (a chat running in the background): the app whose tmux clients had the latest
  activity, that is the app the user touched last;
- nothing to go by: the agent that was asked answers itself, as with a single app.
"""
import os
import re
import stat

from . import tmux
from .appsock import valid_app

PANE = re.compile(r'^%[0-9]{1,9}$')
MAX_ENVIRON = 256 * 1024
ENV_NAME = 'CLAUDESPACE_APP'


def environ_value(pid, name=ENV_NAME):
    """One variable from the environment a process of ours started with (/proc/<pid>/environ), None if absent.
    Only that variable is kept: the rest of a shell's environment may hold tokens and is never parsed or logged."""
    try:
        with open(f'/proc/{int(pid)}/environ', 'rb') as f:
            raw = f.read(MAX_ENVIRON)
    except (OSError, ValueError):
        return None
    key = name.encode() + b'='
    for item in raw.split(b'\0'):
        if item.startswith(key):
            return item[len(key):].decode('utf-8', 'replace')
    return None


def tmux_socket(value):
    """The server socket from $TMUX ("path,pid,session"): an absolute path to a socket of ours, else None."""
    if not isinstance(value, str) or not value:
        return None
    path = value.split(',', 1)[0]
    if not os.path.isabs(path):
        return None
    try:
        st = os.stat(path)
    except OSError:
        return None
    if not stat.S_ISSOCK(st.st_mode) or st.st_uid != os.getuid():
        return None
    return path


def decide(app, clients, pane_session):
    """Pure. app: the script's own CLAUDESPACE_APP (valid or None); clients: [(activity, session, app or None)] of
    the tmux server; pane_session: the session of the script's pane, None outside tmux or when it is gone.
    -> ('app', id) | ('none', None): for no app | ('any', None): whoever was asked answers."""
    if pane_session is not None:
        watching = [c for c in clients if c[1] == pane_session]
        if watching:
            owner = max(watching, key=lambda c: c[0])[2]
            return ('app', owner) if owner else ('none', None)
    elif app:
        return ('app', app)
    touched = [c for c in clients if c[2]]
    if touched:
        return ('app', max(touched, key=lambda c: c[0])[2])
    return ('any', None)


class Router:
    """route(msg) for the socket servers; msg carries the script's $TMUX, $TMUX_PANE and $CLAUDESPACE_APP."""

    def __init__(self, environ=environ_value):
        self.environ = environ

    def __call__(self, msg):
        sock = tmux_socket(msg.get('tmux'))
        base = ['tmux', '-S', sock] if sock else None
        pane = msg.get('pane')
        pane = pane if sock and isinstance(pane, str) and PANE.match(pane) else None
        app = msg.get('app') if valid_app(msg.get('app')) else None
        session = None
        if pane:
            session = tmux.run(['display-message', '-p', '-t', pane, '#{session_name}'], base=base).strip() or None
        return decide(app, self.clients(base), session)

    def clients(self, base):
        out = tmux.run(['list-clients', '-F', '#{client_pid}\t#{client_activity}\t#{client_session}'], base=base)
        res = []
        for line in out.splitlines():
            parts = line.split('\t')
            if len(parts) != 3 or not parts[0].isdigit():
                continue
            try:
                activity = int(parts[1])
            except ValueError:
                activity = 0
            owner = self.environ(parts[0])
            res.append((activity, parts[2], owner if valid_app(owner) else None))
        return res
