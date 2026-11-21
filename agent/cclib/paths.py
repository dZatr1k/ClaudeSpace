"""Paths, the deny-list and a guarded open().

All paths are computed from $HOME at call time via P (reset() re-reads the environment; tests use it).
The deny-list is enforced twice: safe_open() checks explicitly, and install_guard() adds a sys audit hook
that refuses any open()/listdir of a denied path in this process, whoever calls it.
"""
import os
import re
import sys


class Paths:
    def __init__(self, home=None):
        self.home = os.path.realpath(home or os.path.expanduser('~'))
        env = os.environ
        self.projects_root = os.path.join(self.home, 'projects')
        self.claude_dir = os.path.join(self.home, '.claude')
        self.chats_glob = os.path.join(self.claude_dir, 'projects', '*', '*.jsonl')
        # archived chats live OUTSIDE ~/.claude/projects so Claude's own /resume does not list them (same as cc)
        self.archive_dir = os.path.join(self.claude_dir, 'cc-menu-archive')
        self.archive_glob = os.path.join(self.archive_dir, '*', '*.jsonl')
        self.sessions_dir = os.path.join(self.claude_dir, 'sessions')
        self.sessions_glob = os.path.join(self.sessions_dir, '*.json')
        cache = env.get('XDG_CACHE_HOME') or os.path.join(self.home, '.cache')
        state = env.get('XDG_STATE_HOME') or os.path.join(self.home, '.local', 'state')
        self.cache = os.path.join(cache, 'claudespace')
        self.state = os.path.join(state, 'claudespace')
        self.index = os.path.join(self.cache, 'chats.json')
        self.usage_cache = os.path.join(self.cache, 'usage.json')
        self.doctor_log = os.path.join(self.cache, 'doctor.log')
        self.compat = os.path.join(self.state, 'compat.json')
        self.titles = os.path.join(self.state, 'titles.json')
        self.local_bin = os.path.join(self.home, '.local', 'bin')
        self.ssh_dir = os.path.join(self.home, '.ssh')


P = Paths()


def reset(home=None):
    global P
    P = Paths(home)
    return P


# ------------------------------------------------------------------ deny-list
DENY_FILES = ('.credentials.json', 'settings.local.json', 'history.jsonl')


def _homes():
    cached = getattr(P, '_homes', None)
    if cached:
        return cached
    homes = {P.home}
    try:
        import pwd
        homes.add(os.path.realpath(pwd.getpwuid(os.getuid()).pw_dir))
    except (ImportError, KeyError, OSError):
        pass
    P._homes = homes
    return homes


def is_denied(path):
    """True for files the agent must never open: Claude credentials, local settings (Telegram token),
    prompt history, per-session keys and anything under ~/.ssh. Checked for $HOME and the passwd home."""
    if isinstance(path, bytes):
        path = os.fsdecode(path)
    if not isinstance(path, str) or not path:
        return False
    try:
        rp = os.path.realpath(os.path.abspath(path))
    except (OSError, ValueError):
        return True
    parent, name = os.path.dirname(rp), os.path.basename(rp)
    for home in _homes():
        ssh = os.path.join(home, '.ssh')
        cd = os.path.join(home, '.claude')
        if rp == ssh or rp.startswith(ssh + os.sep):
            return True
        if parent == cd and (name in DENY_FILES or name.startswith('.credentials')):
            return True
        if parent == os.path.join(cd, 'sessions') and name.endswith('.key'):
            return True
    return False


class DeniedError(PermissionError):
    pass


def safe_open(path, mode='r', **kw):
    if is_denied(path):
        raise DeniedError(f'refused to open {path}')
    if 'b' not in mode and 'encoding' not in kw:
        kw['encoding'] = 'utf-8'
        kw.setdefault('errors', 'replace')
    return open(path, mode, **kw)


_guard_installed = False
_AUDIT_EVENTS = ('open', 'os.listdir', 'os.scandir')


def _audit(event, args):
    if event in _AUDIT_EVENTS and args:
        p = args[0]
        if isinstance(p, (str, bytes)) and is_denied(p):
            raise DeniedError(f'refused ({event}): {p!r}')


def install_guard():
    """Process-wide: any open/listdir of a denied path raises DeniedError. Cannot be removed."""
    global _guard_installed
    if not _guard_installed:
        sys.addaudithook(_audit)
        _guard_installed = True


# ------------------------------------------------------------------ validation
CHAT_ID_RE = re.compile(r'^[0-9a-f-]{36}$')
SESSION_RE = re.compile(r'^[A-Za-z0-9_-]{1,32}$')


def within_home(rp):
    return rp == P.home or rp.startswith(P.home + os.sep)


def short_path(p):
    if not p:
        return '‹папка?›'
    # the home folder is shown as "home" (same name as its project), e.g. home/docker-learn
    if p == P.home:
        return 'home'
    if p.startswith(P.home + '/'):
        return 'home/' + p[len(P.home) + 1:]
    return p


def atomic_write_json(path, data):
    import json
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.{os.getpid()}.tmp'
    text = json.dumps(data, ensure_ascii=False)   # one C-encoder pass; json.dump writes in small chunks
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, path)
