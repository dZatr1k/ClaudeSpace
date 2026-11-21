"""Project folders: ~/projects/* + folders of chats + created folders + ~; git summary/details; create_project."""
import json
import os
import re
import subprocess
import time

from . import paths


def run(cmd, timeout=2):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except (OSError, subprocess.SubprocessError):
        return ''


def created_file():
    return os.path.join(paths.P.state, 'created-projects.json')


def created_dirs():
    """Folders made by create_project. Listed even when they lie outside ~/projects and have no chat yet."""
    try:
        with open(created_file(), encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    return [d for d in data if isinstance(d, str)] if isinstance(data, list) else []


def remember_created(rp):
    """Add rp to created_dirs(); folders that no longer exist are dropped on the way."""
    keep = [d for d in created_dirs() if d != rp and os.path.isdir(d)]
    try:
        paths.atomic_write_json(created_file(), (keep + [rp])[-200:])
    except OSError:
        pass    # the folder is made; it only stays out of the list until a chat is started there


def project_dirs(chats):
    """-> ([(dir, last_activity_sec)], {dir: last_chat_sec}), most recent first.
    Same as ccdata.project_dirs, plus folders made by create_project (created_dirs)."""
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
    for d in created_dirs():
        if paths.within_home(d) and not paths.is_denied(d) and os.path.isdir(d):
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


WORKTREE_RE = re.compile(r'^(.+)/\.claude/worktrees/([^/]+)$')


def display_name(d):
    P = paths.P
    if d == P.home:
        return HOME_NAME
    m = WORKTREE_RE.match(d or '')
    if m:   # a task worktree (cclib/worktrees.py): «Alpha › fix-login»
        return f'{display_name(m.group(1))} › {m.group(2)}'
    return os.path.basename(d) if d.startswith(P.projects_root + '/') else paths.short_path(d)


def _git(d, *args):
    """git in d. --no-optional-locks: a status must not take .git/index.lock (and so touch .git) behind the user's
    back; the agent asks often, and a lock it holds can make the user's own git command fail."""
    return run(['git', '--no-optional-locks', '-C', d, *args])


def git_info(d):
    out = _git(d, 'status', '--porcelain=v1', '-b')
    if not out:
        return None
    lines = out.splitlines()
    head = lines[0][3:] if lines and lines[0].startswith('## ') else '?'
    branch = head.split('...')[0].replace('No commits yet on ', '')
    ab = re.search(r'\[(.*?)\]', head)
    return dict(branch=branch, dirty=len(lines) > 1, aheadBehind=ab.group(1) if ab else '')


_git_cache = {}   # dir -> (key, info, time)
# an edit in the working tree changes none of the key's mtimes: it shows when the cached summary expires
GIT_TTL = 60.0        # no session in the folder
GIT_TTL_LIVE = 8.0    # a tmux session or Claude runs there (csagent also re-checks a busy Claude's project every 10 s)


def _git_key(d):
    """mtimes of the folder, .git/index and .git/HEAD: a commit, checkout or `git add` asks git again at once.
    Not .git itself: lock files come and go there, so its mtime changes on every git command, ours included."""
    key = []
    for p in (d, os.path.join(d, '.git', 'index'), os.path.join(d, '.git', 'HEAD')):
        try:
            key.append(os.stat(p).st_mtime)
        except OSError:
            key.append(None)
    return tuple(key)


def git_info_cached(d, force=False, live=False, now=None):
    if d == paths.P.home:
        return None
    now = time.time() if now is None else now
    k = _git_key(d)
    c = _git_cache.get(d)
    if c and c[0] == k and not force and now - c[2] < (GIT_TTL_LIVE if live else GIT_TTL):
        return c[1]
    # no .git folder here: still ask git (the folder may be inside a repo)
    info = git_info(d)
    _git_cache[d] = (k, info, now)
    return info


def git_details(d):
    g = git_info(d)
    if not g:
        return None
    changes = []
    for line in _git(d, 'status', '--porcelain=v1').splitlines()[:50]:
        if len(line) > 3:
            changes.append({'status': line[:2].strip() or '?', 'file': line[3:]})
    log = []
    for line in _git(d, 'log', '-8', '--format=%h%x09%ct%x09%s').splitlines():
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
            'git': git_info_cached(d, live=bool(live)) if git else None, 'lastAt': int(ts * 1000),
            'chatCount': nchats.get(d, 0),
            'liveSession': live[0] if live else None, 'liveStatus': live[1] if live else None,
        })
    return out


def expand_home(path):
    """"~" and "~/x" against the agent's home (paths.P.home, not whatever $HOME says)."""
    if path == '~' or path.startswith('~/'):
        return paths.P.home + path[1:]
    return os.path.expanduser(path)


def resolve_existing_dir(path):
    """realpath, must exist, be a directory and lie inside $HOME; else None."""
    if not isinstance(path, str) or not path or '\0' in path:
        return None
    rp = os.path.realpath(expand_home(path))
    if not paths.within_home(rp) or paths.is_denied(rp) or not os.path.isdir(rp):
        return None
    return rp


def not_allowed_text(rp):
    """Why create_project refused rp, with the real home path: the app labels ~ as "home",
    so people type /home/<name> and expect it to be their home folder."""
    home = paths.P.home
    if rp == home:
        return f'Домашняя папка уже есть в списке как home. Новый проект создайте внутри неё, например в {home}/projects.'
    if paths.within_home(rp):
        return f'В {paths.short_path(rp)} проект создать нельзя: приложение не трогает папки с ключами и паролями.'
    name = os.path.basename(rp)
    example = f' Например: {home}/projects/{name}' if name else ''
    return f'Проект можно создать только внутри домашней папки {home}.{example}'


def create_project(path, git_init=False):
    """-> realpath. Raises ValueError(code, message)."""
    if not isinstance(path, str) or not path.strip() or '\0' in path:
        raise ValueError('bad_request', 'пустой путь')
    rp = os.path.realpath(expand_home(path.strip()))
    if not paths.within_home(rp) or rp == paths.P.home or paths.is_denied(rp):
        raise ValueError('not_allowed', not_allowed_text(rp))
    if os.path.exists(rp):
        raise ValueError('exists', f'уже существует: {paths.short_path(rp)}')
    os.makedirs(rp)
    remember_created(rp)
    if git_init:
        subprocess.run(['git', '-C', rp, 'init', '-q'], capture_output=True, timeout=10)
    return rp
