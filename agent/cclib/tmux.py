"""tmux: list/new/kill/rename/select, session info/clients, session names (rules from cc menu.sh).

Always argument lists, never a shell. Target is always '=<name>' (exact match).
CSAGENT_TMUX_SOCKET=<name> uses `tmux -L <name>` (tests use a dedicated socket).
"""
import os
import re
import shlex
import shutil
import subprocess

from . import paths

NAME_RE = paths.SESSION_RE


class TmuxError(Exception):
    pass


def base_cmd():
    sock = os.environ.get('CSAGENT_TMUX_SOCKET')
    return ['tmux', '-L', sock] if sock else ['tmux']


def available():
    return shutil.which('tmux') is not None


def version():
    try:
        out = subprocess.run(['tmux', '-V'], capture_output=True, text=True, timeout=3).stdout.strip()
        return out.split()[-1] if out else None
    except (OSError, subprocess.SubprocessError):
        return None


def run(args, timeout=5, check=False):
    try:
        r = subprocess.run(base_cmd() + args, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        if check:
            raise TmuxError(str(e))
        return ''
    if check and r.returncode != 0:
        raise TmuxError((r.stderr or r.stdout).strip() or f'tmux exit {r.returncode}')
    return r.stdout


def sessions():
    fmt = '\t'.join(['#{session_name}', '#{session_attached}', '#{session_activity}', '#{session_windows}',
                     '#{pane_current_path}', '#{pane_current_command}'])
    res = []
    for line in run(['list-sessions', '-F', fmt]).splitlines():
        f = line.split('\t')
        if len(f) < 6:
            continue
        try:
            res.append(dict(name=f[0], attached=int(f[1] or 0), activity=int(f[2] or 0) * 1000,
                            windows=int(f[3] or 0), path=f[4], command=f[5]))
        except ValueError:
            continue
    return res


def panes():
    """pane id (%N) -> (session name, window index)."""
    m = {}
    for line in run(['list-panes', '-a', '-F', '#{pane_id}\t#{session_name}\t#{window_index}']).splitlines():
        f = line.split('\t')
        if len(f) == 3:
            m[f[0]] = (f[1], f[2])
    return m


def send_keys(pane, *keys, literal=False):
    """tmux send-keys to one pane (%N). literal: the text is typed as is, never read as key names."""
    if not re.fullmatch(r'%\d{1,6}', pane or ''):
        raise TmuxError('неверная панель')
    run(['send-keys', '-t', pane] + (['-l'] if literal else []) + list(keys), check=True)


def pane_paths():
    """[(session name, pane current path)] for every pane of every session."""
    out = []
    for line in run(['list-panes', '-a', '-F', '#{session_name}\t#{pane_current_path}']).splitlines():
        f = line.split('\t')
        if len(f) == 2 and f[1]:
            out.append((f[0], f[1]))
    return out


def has_session(name):
    if not NAME_RE.match(name or ''):
        return False
    try:
        subprocess.run(base_cmd() + ['has-session', '-t', f'={name}'], capture_output=True, timeout=3, check=True)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def sanitize(name, limit=32):
    """[A-Za-z0-9_-], <= limit; a leading '-' becomes '_' (tmux would read it as an option)."""
    s = re.sub(r'[^A-Za-z0-9_-]', '_', (name or '').strip())[:limit]
    return '_' + s[1:] if s.startswith('-') else s


def unique_name(base_dir_or_name, from_dir=True):
    """cc rules: basename (home -> 'home'), [A-Za-z0-9_-], <= 20 chars, suffix -2, -3, ..."""
    if from_dir:
        base = 'home' if base_dir_or_name == paths.P.home else os.path.basename(base_dir_or_name.rstrip('/'))
        base = sanitize(base, 20) or 's'
    else:
        base = sanitize(base_dir_or_name, 20) or 's'
    existing = {s['name'] for s in sessions()}
    n, i = base, 2
    while n in existing:
        n = f'{base}-{i}'
        i += 1
    return n


def claude_command(resume=None):
    """Shell command run inside the new tmux session (same as cc: claude [--resume id]; exec bash -l)."""
    parts = ['unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT;',
             f'export PATH={shlex.quote(paths.P.local_bin)}:"$PATH";',
             'claude']
    if resume:
        parts += ['--resume', shlex.quote(resume)]
    parts += [';', 'exec bash -l']
    return ' '.join(parts)


def new_session(name, cwd, command, window_name='claude'):
    """-> window index (str)."""
    if not NAME_RE.match(name):
        raise TmuxError('bad session name')
    out = run(['new-session', '-d', '-s', name, '-c', cwd, '-n', window_name, '-P', '-F', '#{window_index}',
               command], check=True)
    return out.strip() or '0'


def kill(name):
    run(['kill-session', '-t', f'={name}'], check=True)


def rename(name, new):
    run(['rename-session', '-t', f'={name}', new], check=True)


def select_window(name, window):
    run(['select-window', '-t', f'={name}:{window}'], check=True)


def session_info(name):
    """-> {created: ms|None, clients: [{tty, term, activity, created, size}]} for one session (exact match)."""
    created = None
    out = run(['display-message', '-p', '-t', f'={name}:', '#{session_created}']).strip()
    if out.isdigit():
        created = int(out) * 1000
    clients = []
    fmt = '\t'.join(['#{client_tty}', '#{client_termname}', '#{client_activity}', '#{client_created}',
                     '#{client_width}x#{client_height}'])
    for line in run(['list-clients', '-t', f'={name}', '-F', fmt]).splitlines():
        f = line.split('\t')
        if len(f) < 5:
            continue
        try:
            clients.append(dict(tty=f[0], term=f[1], activity=int(f[2] or 0) * 1000,
                                created=int(f[3] or 0) * 1000, size=f[4]))
        except ValueError:
            continue
    return {'created': created, 'clients': clients}
