"""Read-only git for the Git panel: status, the diff of one file, recent commits. Nothing here writes to a repo
(changes are made in Claude Code or lazygit)."""
import os
import re
import subprocess

from . import paths

MAX_DIFF = 400 * 1024
MAX_FILES = 1000


class GitError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def _git(root, *args, timeout=10, ok=(0,)):
    try:
        r = subprocess.run(['git', '-C', root, *args], capture_output=True, timeout=timeout,
                           env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0', 'LC_ALL': 'C'})
    except subprocess.TimeoutExpired:
        raise GitError('timeout', 'git не ответил вовремя')
    except OSError:
        raise GitError('internal', 'git не найден')
    if r.returncode not in ok:
        raise GitError('git_error', r.stderr.decode('utf-8', 'replace').strip()[:300] or 'ошибка git')
    return r.stdout


def repo_root(d):
    """Top level of the repo containing d (inside $HOME), or None if d is not in a repo."""
    try:
        out = _git(d, 'rev-parse', '--show-toplevel').decode('utf-8', 'replace').strip()
    except GitError:
        return None
    rp = os.path.realpath(out) if out else None
    return rp if rp and paths.within_home(rp) else None


def _xy(code):
    return {'M': 'modified', 'T': 'modified', 'A': 'added', 'D': 'deleted', 'R': 'renamed', 'C': 'copied',
            'U': 'conflict'}.get(code)


def status(d):
    """-> {root, branch, upstream, ahead, behind, files: [{path, orig?, staged, unstaged, untracked, conflict}],
    truncated} or {root: None} outside a repo."""
    root = repo_root(d)
    if not root:
        return {'root': None}
    raw = _git(root, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all')
    branch, upstream, ahead, behind = None, None, 0, 0
    files = []
    parts = raw.split(b'\0')
    i = 0
    while i < len(parts):
        line = parts[i].decode('utf-8', 'replace')
        i += 1
        if not line:
            continue
        if line.startswith('# branch.head '):
            branch = line[14:]
            if branch == '(detached)':
                branch = None
        elif line.startswith('# branch.upstream '):
            upstream = line[18:]
        elif line.startswith('# branch.ab '):
            for tok in line[12:].split():
                if tok.startswith('+'):
                    ahead = int(tok[1:] or 0)
                elif tok.startswith('-'):
                    behind = int(tok[1:] or 0)
        elif line[:2] in ('1 ', '2 ', 'u '):
            f = line.split(' ')
            xy = f[1]
            if line[0] == '1':
                path, orig = ' '.join(f[8:]), None
            elif line[0] == '2':
                path, orig = ' '.join(f[9:]), parts[i].decode('utf-8', 'replace')
                i += 1
            else:
                path, orig = ' '.join(f[10:]), None
            conflict = line[0] == 'u'
            files.append({'path': path, 'orig': orig, 'conflict': conflict, 'untracked': False,
                          'staged': None if conflict else _xy(xy[0]),
                          'unstaged': None if conflict else _xy(xy[1])})
        elif line.startswith('? '):
            files.append({'path': line[2:], 'orig': None, 'conflict': False, 'untracked': True,
                          'staged': None, 'unstaged': None})
    truncated = len(files) > MAX_FILES
    return {'root': root, 'branch': branch, 'upstream': upstream, 'ahead': ahead, 'behind': behind,
            'files': files[:MAX_FILES], 'truncated': truncated}


def _inside(root, rel):
    if not isinstance(rel, str) or not rel or '\0' in rel or rel.startswith('/') or len(rel) > 4096:
        raise GitError('bad_request', 'неверный путь файла')
    full = os.path.realpath(os.path.join(root, rel))
    if not (full == root or full.startswith(root + os.sep)) or paths.is_denied(full):
        raise GitError('not_allowed', 'файл вне репозитория или закрыт')
    return full


def diff(d, rel, staged=False, untracked=False):
    """-> {root, file, diff, truncated, binary}. untracked: the whole file as added."""
    root = repo_root(d)
    if not root:
        raise GitError('not_found', 'это не git-репозиторий')
    full = _inside(root, rel)
    if untracked:
        # relative to the repo root (git runs there), so the header shows b/<file>, not the absolute path
        out = _git(root, 'diff', '--no-color', '--no-index', '--', '/dev/null', os.path.relpath(full, root), ok=(0, 1))
    else:
        args = ['diff', '--no-color', '--no-ext-diff', '-M']
        if staged:
            args.append('--cached')
        out = _git(root, *args, '--', rel)
    truncated = len(out) > MAX_DIFF
    text = out[:MAX_DIFF].decode('utf-8', 'replace')
    binary = text.startswith('diff --git') and '\nBinary files ' in text[:2000]
    return {'root': root, 'file': rel, 'diff': text, 'truncated': truncated, 'binary': binary}


HASH_RE = re.compile(r'^[0-9a-f]{7,40}$')


def show(d, commit):
    """-> {root, hash, diff, truncated}: one commit, header + changed files + patch (merges: their own changes)."""
    if not isinstance(commit, str) or not HASH_RE.match(commit):
        raise GitError('bad_request', 'неверный хеш коммита')
    root = repo_root(d)
    if not root:
        raise GitError('not_found', 'это не git-репозиторий')
    try:
        out = _git(root, 'show', '--no-color', '--no-ext-diff', '-M', '--stat=100', '--patch', '--format=medium',
                   '--first-parent', commit, '--')
    except GitError as e:
        raise GitError('not_found', f'коммит {commit} не найден: {e}')
    truncated = len(out) > MAX_DIFF
    return {'root': root, 'hash': commit, 'diff': out[:MAX_DIFF].decode('utf-8', 'replace'), 'truncated': truncated}


def log(d, limit=30):
    """-> {root, commits: [{hash, short, subject, author, at}]}"""
    root = repo_root(d)
    if not root:
        return {'root': None, 'commits': []}
    try:
        raw = _git(root, 'log', f'-{int(limit)}', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct%x1e')
    except GitError:
        return {'root': root, 'commits': []}  # a repo with no commits yet
    commits = []
    for rec in raw.decode('utf-8', 'replace').split('\x1e'):
        f = rec.strip('\n').split('\x1f')
        if len(f) == 5:
            try:
                commits.append({'hash': f[0], 'short': f[1], 'subject': f[2], 'author': f[3], 'at': int(f[4]) * 1000})
            except ValueError:
                pass
    return {'root': root, 'commits': commits}
