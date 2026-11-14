"""Parallel tasks in git worktrees: a branch checked out in its own folder, so a second Claude works there without
touching the main checkout.

- Folder: <main checkout>/.claude/worktrees/<name> (the layout Claude Code itself uses), hidden from `git status`
  through .git/info/exclude (local to this clone, nothing is committed).
- Create: `git worktree add -b <branch> <folder> <base>`, or an existing branch that is not checked out anywhere.
- Remove: only a linked worktree of this repo (never the main checkout), refused while it has uncommitted changes
  (unless force) or a tmux session works inside it; the branch is deleted only with `git branch -d` (merged).
"""
import os
import re

from . import paths, tmux
from .gitview import GitError, _git, repo_root

BRANCH_RE = re.compile(r'^(?!-)(?!.*\.\.)(?!.*//)(?!.*@\{)[A-Za-z0-9._/-]{1,60}(?<![./])$')
EXCLUDE_LINE = '/.claude/worktrees/'
MAX_LIST = 50


def _list(root):
    """[{path, head, branch, detached, locked, prunable}] from `git worktree list --porcelain -z`; first = main."""
    raw = _git(root, 'worktree', 'list', '--porcelain', '-z').decode('utf-8', 'replace')
    out, cur = [], None
    for tok in raw.split('\0'):
        if not tok:
            if cur:
                out.append(cur)
            cur = None
            continue
        key, _, val = tok.partition(' ')
        if key == 'worktree':
            cur = {'path': val, 'head': None, 'branch': None, 'detached': False, 'locked': False, 'prunable': False}
        elif cur is None:
            continue
        elif key == 'HEAD':
            cur['head'] = val
        elif key == 'branch':
            cur['branch'] = val[len('refs/heads/'):] if val.startswith('refs/heads/') else val
        elif key == 'detached':
            cur['detached'] = True
        elif key == 'locked':
            cur['locked'] = True
        elif key == 'prunable':
            cur['prunable'] = True
    if cur:
        out.append(cur)
    return out


def _main(d):
    root = repo_root(d)
    if not root:
        raise GitError('not_found', 'это не git-репозиторий')
    wts = _list(root)
    main = os.path.realpath(wts[0]['path']) if wts else root
    if not paths.within_home(main):
        raise GitError('not_allowed', 'репозиторий вне домашней папки')
    return main, wts


def _sessions_in(folder):
    return [s['name'] for s in tmux.sessions()
            if s.get('path') and (s['path'] == folder or s['path'].startswith(folder + os.sep))]


def _dirty(folder):
    try:
        out = _git(folder, 'status', '--porcelain', '-z', '--untracked-files=normal', timeout=5)
    except GitError:
        return None
    return len([x for x in out.split(b'\0') if x])


def list_worktrees(d):
    """-> {main, current, worktrees: [{path, branch, head, detached, locked, prunable, dirty, sessions, ours}]}.
    current: the worktree d is in; ours: made under .claude/worktrees (by this app or Claude Code)."""
    main, wts = _main(d)
    cur = repo_root(d)
    base = os.path.join(main, '.claude', 'worktrees')
    out = []
    for w in wts[1:MAX_LIST + 1]:
        p = os.path.realpath(w['path'])
        inside = paths.within_home(p) and not paths.is_denied(p)
        out.append(dict(w, path=p, dirty=_dirty(p) if inside and os.path.isdir(p) else None,
                        sessions=_sessions_in(p) if inside else [], ours=p.startswith(base + os.sep)))
    return {'main': main, 'current': cur, 'worktrees': out}


def _exclude(main):
    """Hide .claude/worktrees from `git status` of the main checkout (local .git/info/exclude, not committed)."""
    try:
        common = _git(main, 'rev-parse', '--git-common-dir').decode('utf-8', 'replace').strip()
    except GitError:
        return
    gd = os.path.realpath(os.path.join(main, common))
    ex = os.path.join(gd, 'info', 'exclude')
    if not paths.within_home(gd):
        return
    try:
        with open(ex, encoding='utf-8', errors='replace') as f:
            text = f.read()
    except OSError:
        text = ''
    if EXCLUDE_LINE in text.split('\n'):
        return
    os.makedirs(os.path.dirname(ex), exist_ok=True)
    with open(ex, 'a', encoding='utf-8') as f:
        f.write(('' if not text or text.endswith('\n') else '\n') + EXCLUDE_LINE + '\n')


def create(d, branch, base=None):
    """-> {path, branch, base, created}: created = a new branch (False: an existing one checked out)."""
    if not isinstance(branch, str) or not BRANCH_RE.match(branch):
        raise GitError('bad_request', 'имя ветки: латиница, цифры, . _ - /, до 60 символов')
    if base is not None and (not isinstance(base, str) or not BRANCH_RE.match(base)):
        raise GitError('bad_request', 'неверная исходная ветка')
    main, wts = _main(d)
    if any(w['branch'] == branch for w in wts):
        raise GitError('exists', f'ветка {branch} уже открыта в другой папке')
    folder = os.path.join(main, '.claude', 'worktrees', branch.replace('/', '-'))
    if os.path.lexists(folder):
        raise GitError('exists', f'папка {paths.short_path(folder)} уже есть')
    exists = True
    try:
        _git(main, 'rev-parse', '--verify', '--quiet', f'refs/heads/{branch}')
    except GitError:
        exists = False
    if base:
        try:
            _git(main, 'rev-parse', '--verify', '--quiet', f'{base}^{{commit}}')
        except GitError:
            raise GitError('not_found', f'нет ветки или коммита {base}')
    os.makedirs(os.path.dirname(folder), exist_ok=True)
    _exclude(main)
    if exists:
        _git(main, 'worktree', 'add', folder, branch, timeout=60)
    else:
        _git(main, 'worktree', 'add', '-b', branch, folder, *([base] if base else []), timeout=60)
    return {'path': os.path.realpath(folder), 'branch': branch, 'base': base, 'created': not exists}


def remove(d, folder, force=False, delete_branch=False):
    """-> {path, removed, branch, branchDeleted, branchKept?: reason}"""
    main, wts = _main(d)
    if not isinstance(folder, str) or not folder:
        raise GitError('bad_request', 'нет папки')
    rp = os.path.realpath(folder)
    w = next((x for x in wts[1:] if os.path.realpath(x['path']) == rp), None)
    if not w:
        raise GitError('not_found', 'это не дополнительная папка (worktree) этого репозитория')
    if not paths.within_home(rp) or paths.is_denied(rp):
        raise GitError('not_allowed', 'папка вне домашней папки')
    busy = _sessions_in(rp)
    if busy:
        raise GitError('busy', f'в этой папке открыта сессия {", ".join(busy)}: закройте её сначала')
    if not force and os.path.isdir(rp) and _dirty(rp):
        raise GitError('dirty', 'в папке есть незакоммиченные правки')
    _git(main, 'worktree', 'remove', *(['--force'] if force else []), rp, timeout=60)
    res = {'path': rp, 'removed': True, 'branch': w['branch'], 'branchDeleted': False}
    if delete_branch and w['branch']:
        try:
            _git(main, 'branch', '-d', w['branch'])
            res['branchDeleted'] = True
        except GitError:
            res['branchKept'] = 'ветка не влита: оставлена, удалить можно в lazygit'
    return res
