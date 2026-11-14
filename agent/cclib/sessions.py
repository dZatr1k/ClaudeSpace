"""Running Claude Code processes: ~/.claude/sessions/<pid>.json (never the *.key files next to them)."""
import glob
import json
import os

from . import paths
from .paths import safe_open

_cache = {}   # path -> (mtime, size, data)


def proc_alive(pid, proc_start):
    try:
        with open(f'/proc/{int(pid)}/stat') as f:
            fields = f.read().rsplit(')', 1)[1].split()
        return not proc_start or fields[19] == str(proc_start)
    except (OSError, IndexError, ValueError, TypeError):
        return False


def _read(p):
    try:
        st = os.stat(p)
    except OSError:
        _cache.pop(p, None)
        return None
    c = _cache.get(p)
    if c and c[0] == st.st_mtime and c[1] == st.st_size:
        return c[2]
    try:
        with safe_open(p) as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = None
    _cache[p] = (st.st_mtime, st.st_size, data)
    return data


def live():
    """Every live Claude process: [{chatId, status, pid, tmux, cwd, name, statusAt, version}]."""
    out = []
    files = glob.glob(paths.P.sessions_glob)     # only *.json
    for p in list(_cache):
        if p not in files:
            _cache.pop(p, None)
    for p in files:
        s = _read(p)
        if not isinstance(s, dict):
            continue
        pid = s.get('pid')
        if not pid or not proc_alive(pid, s.get('procStart')):
            continue
        sid = s.get('sessionId')
        if not sid:
            continue
        out.append(dict(chatId=sid, status=s.get('status') or '?', pid=pid, tmux=s.get('tmux') or None,
                        cwd=s.get('cwd'), name=s.get('name'), version=s.get('version'),
                        statusAt=s.get('statusUpdatedAt') or s.get('updatedAt') or 0))
    return out


def by_chat(procs=None):
    """chat id -> best process (prefer the one in tmux, then the freshest), like ccdata.running_claude()."""
    res = {}
    for r in procs if procs is not None else live():
        cur = res.get(r['chatId'])
        if not cur or (bool(r['tmux']), r['statusAt']) > (bool(cur['tmux']), cur['statusAt']):
            res[r['chatId']] = r
    return res


def pane_id(proc):
    """'MyApp:@10.%10' -> '%10'."""
    t = (proc or {}).get('tmux') or ''
    return t.rsplit('.', 1)[-1] if '.' in t else None
