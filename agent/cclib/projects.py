"""Project folders: ~/projects/* + folders of chats + ~; git summary/details; create_project."""
import os
import re
import subprocess

from . import paths


def run(cmd, timeout=2):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except (OSError, subprocess.SubprocessError):
        return ''


def project_dirs(chats):
    """-> ([(dir, last_activity_sec)], {dir: last_chat_sec}), most recent first (= ccdata.project_dirs)."""
    P = paths.P
    last = {}
    for c in chats:
        d = c.get('cwd')
        if d:
            last[d] = max(last.get(d, 0), c.get('last_ts') or 0)
    dirs = set()
    if os.path.isdir(P.projects_root):
        for e in os.scandir(P.projects_root):
            if e.is_dir() and not e.name.startswith('.'):
                dirs.add(e.path)
    for d in last:
        if os.path.isdir(d) and not d.startswith(P.claude_dir) and not d.startswith('/tmp'):
            dirs.add(d)
    dirs.add(P.home)
    res = []
    for d in dirs:
        try:
            m = os.stat(d).st_mtime
        except OSError:
            m = 0
        res.append((d, max(m, last.get(d, 0))))
    res.sort(key=lambda x: -x[1])
    return res, last


HOME_NAME = 'home'  # the home folder is shown as a project named "home", not "~"


def display_name(d):
    P = paths.P
    if d == P.home:
        return HOME_NAME
    return os.path.basename(d) if d.startswith(P.projects_root + '/') else paths.short_path(d)


def git_info(d):
    out = run(['git', '-C', d, 'status', '--porcelain=v1', '-b'])
    if not out:
        return None
    lines = out.splitlines()
    head = lines[0][3:] if lines and lines[0].startswith('## ') else '?'
    branch = head.split('...')[0].replace('No commits yet on ', '')
    ab = re.search(r'\[(.*?)\]', head)
    return dict(branch=branch, dirty=len(lines) > 1, aheadBehind=ab.group(1) if ab else '')


_git_cache = {}   # dir -> (key, info)


def _git_key(d):
    key = []
    for p in (d, os.path.join(d, '.git'), os.path.join(d, '.git', 'index'), os.path.join(d, '.git', 'HEAD')):
        try:
            key.append(os.stat(p).st_mtime)
        except OSError:
            key.append(None)
    return tuple(key)


def git_info_cached(d, force=False):
    if d == paths.P.home:
        return None
    k = _git_key(d)
    c = _git_cache.get(d)
    if c and c[0] == k and not force:
        return c[1]
    # no .git folder here: still ask git once (the folder may be inside a repo), then cache by mtime
    info = git_info(d)
    _git_cache[d] = (k, info)
    return info


def git_details(d):
    g = git_info(d)
    if not g:
        return None
    changes = []
    for line in run(['git', '-C', d, 'status', '--porcelain=v1']).splitlines()[:50]:
        if len(line) > 3:
            changes.append({'status': line[:2].strip() or '?', 'file': line[3:]})
    log = []
    for line in run(['git', '-C', d, 'log', '-8', '--format=%h%x09%ct%x09%s']).splitlines():
        f = line.split('\t', 2)
        if len(f) == 3:
            try:
                log.append({'hash': f[0], 'at': int(f[1]) * 1000, 'subject': f[2]})
            except ValueError:
                pass
    return dict(g, changes=changes, log=log)


def entries(d, limit=60):
    try:
        names = sorted(e.name + ('/' if e.is_dir() else '') for e in os.scandir(d) if not e.name.startswith('.'))
    except OSError:
        return []
    return names[:limit]


def build(chats_raw, live_by_project, git=True):
    """Project models (see model.ts). chats_raw: non-archived raw chats.
    live_by_project: {dir: (session, status)} for running Claude / tmux sessions."""
    from .chats import visible
    dirs, _ = project_dirs(chats_raw)
    nchats = {}
    for c in visible(chats_raw):
        nchats[c.get('cwd')] = nchats.get(c.get('cwd'), 0) + 1
    out = []
    for d, ts in dirs:
        live = live_by_project.get(d)
        out.append({
            'path': d, 'name': display_name(d), 'isHome': d == paths.P.home,
            'git': git_info_cached(d) if git else None, 'lastAt': int(ts * 1000), 'chatCount': nchats.get(d, 0),
            'liveSession': live[0] if live else None, 'liveStatus': live[1] if live else None,
        })
    return out


def resolve_existing_dir(path):
    """realpath, must exist, be a directory and lie inside $HOME; else None."""
    if not isinstance(path, str) or not path or '\0' in path:
        return None
    rp = os.path.realpath(os.path.expanduser(path))
    if not paths.within_home(rp) or paths.is_denied(rp) or not os.path.isdir(rp):
        return None
    return rp


def create_project(path, git_init=False):
    """-> realpath. Raises ValueError(code, message)."""
    if not isinstance(path, str) or not path.strip() or '\0' in path:
        raise ValueError('bad_request', 'пустой путь')
    rp = os.path.realpath(os.path.expanduser(path.strip()))
    if not paths.within_home(rp) or rp == paths.P.home or paths.is_denied(rp):
        raise ValueError('not_allowed', 'папка должна быть внутри домашней')
    if os.path.exists(rp):
        raise ValueError('exists', f'уже существует: {paths.short_path(rp)}')
    os.makedirs(rp)
    if git_init:
        subprocess.run(['git', '-C', rp, 'init', '-q'], capture_output=True, timeout=10)
    return rp
