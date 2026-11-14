"""«Диск ПК» (BACKLOG 12): mount the PC's folders over the reverse tunnel with the user's own `~/.local/bin/winfs`.

- Mount: `winfs <C:/path> <dst>` (fixed script, argument list, validated params). Nothing else is executed.
- Unmount: `fusermount3 -u [-z] <dst>` for that one mount (`winfs -u` would unmount every ~/winfs/* mount,
  including ones the user made by hand).
- Ownership: a mount is «ours» only if the agent mounted it; recorded in ~/.local/state/claudespace/winfs.json as
  {dst: {mountId, pid}} — the kernel mount id makes a later manual mount on the same folder not ours. A mount that
  existed before (manual `winfs`) is never unmounted automatically.
- On EOF (the app's connection is gone) the agent lazily unmounts the mounts *it* (this pid) owns, so a dead tunnel
  never leaves a hanging sshfs behind; a newer agent that took a mount over (same mountId, its pid) keeps it.
"""
import json
import os
import re
import shutil
import subprocess
import threading

from . import paths

LOCK = threading.RLock()
SEG_RE = re.compile(r"^[\w .,()\[\]{}@#&+~!'-]+$")
SSHFS_HOST = 'winpc:'


class WinfsError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def mountinfo_path():
    return os.environ.get('CSAGENT_MOUNTINFO') or '/proc/self/mountinfo'


def winfs_path():
    return os.path.join(paths.P.local_bin, 'winfs')


def state_path():
    return os.path.join(paths.P.state, 'winfs.json')


# ------------------------------------------------------------------ validation
def norm_src(raw):
    """Windows path on the PC: 'C:\\Data' / 'c:/Data/' -> 'C:/Data'. Raises WinfsError."""
    if not isinstance(raw, str) or not raw or len(raw) > 260 or '\0' in raw:
        raise WinfsError('bad_request', 'неверный путь на ПК')
    s = raw.strip().replace('\\', '/')
    m = re.match(r'^([A-Za-z]):(/.*)?$', s)
    if not m:
        raise WinfsError('bad_request', 'путь на ПК должен быть вида C:\\Папка')
    segs = [x for x in (m.group(2) or '').split('/') if x]
    for x in segs:
        if x in ('.', '..') or not SEG_RE.match(x):
            raise WinfsError('bad_request', f'недопустимое имя в пути на ПК: {x[:40]}')
    return m.group(1).upper() + ':/' + '/'.join(segs) if segs else m.group(1).upper() + ':/'


def norm_dst(raw, must_be_free=True):
    """Mount point on the VM: inside $HOME (not $HOME itself), no hidden components (~/.ssh, ~/.claude, ~/.local…),
    no '..', symlinks must not lead outside; for a new mount the folder must be absent or empty."""
    if not isinstance(raw, str) or not raw or len(raw) > 1024 or '\0' in raw:
        raise WinfsError('bad_request', 'неверная папка на VM')
    home = paths.P.home
    s = raw.strip()
    if s == '~' or s.startswith('~/'):
        s = home + s[1:]
    if not os.path.isabs(s):
        raise WinfsError('bad_request', 'папка на VM: абсолютный путь или ~/…')
    if '..' in s.split('/'):
        raise WinfsError('not_allowed', 'папка на VM не может содержать ..')
    p = os.path.normpath(s)
    if not p.startswith(home + os.sep):
        raise WinfsError('not_allowed', 'папка на VM должна быть внутри домашней папки')
    rel = p[len(home) + 1:].split(os.sep)
    if any(x.startswith('.') for x in rel):
        raise WinfsError('not_allowed', 'скрытые папки (~/.ssh, ~/.claude…) нельзя')
    # resolve symlinks of the existing part of the PARENT (never stat the mount point itself: a dead sshfs hangs)
    probe = os.path.dirname(p)
    while not os.path.lexists(probe):
        probe = os.path.dirname(probe)
    rp = os.path.realpath(probe)
    if not paths.within_home(rp):
        raise WinfsError('not_allowed', 'папка на VM ведёт за пределы домашней папки')
    if must_be_free and not is_mounted(p) and os.path.lexists(p):
        if os.path.islink(p) or not os.path.isdir(p):
            raise WinfsError('exists', f'{paths.short_path(p)} не папка')
        try:
            if os.listdir(p):
                raise WinfsError('exists', f'папка {paths.short_path(p)} не пуста, подключать туда нельзя')
        except OSError as e:
            raise WinfsError('not_allowed', f'нет доступа к {paths.short_path(p)}: {e.strerror}')
    return p


# ------------------------------------------------------------------ mounts
def _unescape(s):
    return re.sub(r'\\([0-7]{3})', lambda m: chr(int(m.group(1), 8)), s)


def parse_mountinfo(text):
    """[{id, dst, fstype, source}] from /proc/self/mountinfo text."""
    out = []
    for line in text.splitlines():
        if ' - ' not in line:
            continue
        left, right = line.split(' - ', 1)
        lf, rf = left.split(), right.split()
        if len(lf) < 5 or len(rf) < 2:
            continue
        out.append({'id': lf[0], 'dst': _unescape(lf[4]), 'fstype': rf[0], 'source': _unescape(rf[1])})
    return out


def _all_mounts():
    try:
        with open(mountinfo_path(), encoding='utf-8', errors='replace') as f:
            return parse_mountinfo(f.read())
    except OSError:
        return []


def sshfs_mounts():
    """sshfs mounts inside $HOME: {dst: {id, src}}."""
    res = {}
    for m in _all_mounts():
        if m['fstype'] == 'fuse.sshfs' and paths.within_home(m['dst']) and m['dst'] != paths.P.home:
            src = m['source']
            if src.startswith(SSHFS_HOST + '/'):
                src = src[len(SSHFS_HOST) + 1:]
            res[m['dst']] = {'id': m['id'], 'src': src}
    return res


def is_mounted(dst):
    return any(m['dst'] == dst for m in _all_mounts())


def _load_state():
    try:
        with paths.safe_open(state_path()) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_state(st):
    paths.atomic_write_json(state_path(), st)


def status():
    """[{dst, src, owned}] for sshfs mounts in $HOME; forgets ownership of mounts that are gone."""
    with LOCK:
        cur = sshfs_mounts()
        st = _load_state()
        keep = {d: v for d, v in st.items() if isinstance(v, dict) and d in cur and cur[d]['id'] == v.get('mountId')}
        if keep != st:
            _save_state(keep)
        return [{'dst': d, 'src': m['src'], 'owned': d in keep} for d, m in sorted(cur.items())]


def _run(argv, timeout):
    env = dict(os.environ)
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=env, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise WinfsError('timeout', f'{os.path.basename(argv[0])}: нет ответа за {timeout} с')
    except OSError as e:
        raise WinfsError('internal', f'{os.path.basename(argv[0])}: {e.strerror}')
    return r


def _last_line(r):
    text = (r.stderr or r.stdout or '').strip().splitlines()
    return text[-1][:300] if text else f'код {r.returncode}'


def mount(src_raw, dst_raw, pid=None):
    """Mount (or take over our own earlier mount). -> {dst, src, owned, already}."""
    pid = os.getpid() if pid is None else pid
    src = norm_src(src_raw)
    with LOCK:
        dst = norm_dst(dst_raw)
        cur = sshfs_mounts()
        st = _load_state()
        if dst in cur:
            mine = st.get(dst)
            owned = isinstance(mine, dict) and mine.get('mountId') == cur[dst]['id']
            if owned:      # a newer agent (reconnect) takes over the mount the previous one made
                st[dst] = {'mountId': cur[dst]['id'], 'pid': pid}
                _save_state(st)
            return {'dst': dst, 'src': cur[dst]['src'], 'owned': owned, 'already': True}
        if is_mounted(dst):
            raise WinfsError('exists', f'в {paths.short_path(dst)} уже подключено что-то другое')
        exe = winfs_path()
        if not os.access(exe, os.X_OK):
            raise WinfsError('not_found', 'нет ~/.local/bin/winfs на VM')
        r = _run([exe, src, dst], 40)
        cur = sshfs_mounts()
        if dst not in cur:
            raise WinfsError('mount_failed', f'winfs: {_last_line(r)}')
        st = _load_state()
        st[dst] = {'mountId': cur[dst]['id'], 'pid': pid}
        _save_state(st)
        return {'dst': dst, 'src': cur[dst]['src'], 'owned': True, 'already': False}


def _fusermount():
    return shutil.which('fusermount3') or shutil.which('fusermount')


def unmount(dst_raw, only_owned=True, lazy=False):
    """-> {dst, unmounted, skipped?: 'manual' | 'not_mounted'}."""
    with LOCK:
        dst = norm_dst(dst_raw, must_be_free=False)
        cur = sshfs_mounts()
        if dst not in cur:
            return {'dst': dst, 'unmounted': False, 'skipped': 'not_mounted'}
        st = _load_state()
        mine = st.get(dst)
        owned = isinstance(mine, dict) and mine.get('mountId') == cur[dst]['id']
        if only_owned and not owned:
            return {'dst': dst, 'unmounted': False, 'skipped': 'manual'}
        fm = _fusermount()
        if not fm:
            raise WinfsError('not_found', 'нет fusermount3 на VM')
        r = _run([fm, '-u', '-z', dst] if lazy else [fm, '-u', dst], 15)
        if dst in sshfs_mounts():
            msg = _last_line(r)
            if 'busy' in msg.lower():
                msg = f'диск занят: закройте файлы и терминалы в {paths.short_path(dst)}'
            raise WinfsError('busy', msg)
        st.pop(dst, None)
        _save_state(st)
        return {'dst': dst, 'unmounted': True}


def cleanup(pid=None):
    """On agent exit: lazily unmount the mounts this agent process owns. Returns the unmounted paths."""
    pid = os.getpid() if pid is None else pid
    done = []
    with LOCK:
        cur = sshfs_mounts()
        for dst, v in _load_state().items():
            if isinstance(v, dict) and v.get('pid') == pid and dst in cur and cur[dst]['id'] == v.get('mountId'):
                try:
                    unmount(dst, only_owned=True, lazy=True)
                    done.append(dst)
                except WinfsError:
                    pass
    return done
