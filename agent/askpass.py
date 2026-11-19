#!/usr/bin/env -S python3 -I
"""ClaudeSpace askpass for `sudo -A` (BACKLOG 11): the password prompt appears in the ClaudeSpace window on the PC.

  export SUDO_ASKPASS="$HOME/.local/lib/claudespace/askpass.py"

sudo runs this with the prompt as argv[1] and reads the password from stdout. The running ClaudeSpace agent serves a
unix socket (~/.cache/claudespace/run/askpass.sock, 0600, same uid only); we send what asks and wait for the answer.
- answer -> password + newline on stdout, exit 0;  cancel / timeout / the app disconnected -> exit 1 (sudo aborts);
- no socket or no app listening -> the user's own GTK prompt ~/.local/bin/sudo-askpass, if there is a desktop
  (DISPLAY/WAYLAND_DISPLAY), else exit 1.
Several apps on this VM (the PC and the phone): the agent may answer {"status": "redirect", "app": ID}, the request
belongs to another app, and we repeat it on that app's socket askpass.<ID>.sock (cclib/route.py decides).
Stdlib only, no imports from the agent. The password is never written anywhere but stdout.
"""
import json
import os
import re
import socket
import sys

WAIT = 135          # the agent gives up after 120 s and tells us; this is only a safety net
FALLBACK = os.path.join('~', '.local', 'bin', 'sudo-askpass')
APP_ID = re.compile(r'^[0-9a-f]{16}$')


def sock_path(name='askpass'):
    cache = os.environ.get('XDG_CACHE_HOME') or os.path.join(os.path.expanduser('~'), '.cache')
    return os.path.join(cache, 'claudespace', 'run', f'{name}.sock')


def parent_cmdline():
    try:
        with open(f'/proc/{os.getppid()}/cmdline', 'rb') as f:
            return f.read(8192).rstrip(b'\0').replace(b'\0', b' ').decode('utf-8', 'replace').strip()
    except OSError:
        return ''


def fallback(prompt_args):
    """No ClaudeSpace to ask: hand over to the user's GTK prompt (exec keeps our pid, so it sees sudo as parent)."""
    gtk = os.path.expanduser(FALLBACK)
    me = os.path.realpath(__file__)
    has_display = bool(os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY'))
    if has_display and os.path.isfile(gtk) and os.access(gtk, os.X_OK) and os.path.realpath(gtk) != me:
        try:
            os.execv(gtk, [gtk] + prompt_args)
        except OSError as e:
            sys.stderr.write(f'claudespace-askpass: {gtk}: {e}\n')
            return 1
    sys.stderr.write('claudespace-askpass: ClaudeSpace не подключено, а графического окна для пароля нет\n')
    return 1


def exchange(path, msg):
    """One request on one socket -> ('ok', answer dict) | ('unavailable', None): nobody listens there |
    ('disconnected', None): the agent went away while we waited | ('bad', None)."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.settimeout(3)
        try:
            s.connect(path)
        except OSError:
            return 'unavailable', None          # no agent (never started, or a stale socket of a dead one)
        s.sendall(json.dumps(msg, ensure_ascii=False).encode('utf-8') + b'\n')
        s.settimeout(WAIT)
        buf = b''
        while b'\n' not in buf:
            try:
                chunk = s.recv(4096)
            except OSError:
                return 'disconnected', None
            if not chunk:
                return 'disconnected', None     # the agent went away while we waited: the app is gone
            buf += chunk
            if len(buf) > 64 * 1024:
                return 'bad', None
    finally:
        s.close()
    try:
        res = json.loads(buf.split(b'\n', 1)[0].decode('utf-8'))
    except ValueError:
        return 'bad', None
    return ('ok', res) if isinstance(res, dict) else ('bad', None)


def ask(prompt):
    """-> ('ok', password) | (status, None); status 'unavailable' means: fall back."""
    msg = {'v': 1, 'prompt': prompt, 'pane': os.environ.get('TMUX_PANE') or None,
           'tmux': os.environ.get('TMUX') or None, 'app': os.environ.get('CLAUDESPACE_APP') or None,
           'command': parent_cmdline(), 'cwd': os.getcwd() if os.path.isdir('.') else None}
    st, res = exchange(sock_path(), msg)
    if st == 'ok' and res.get('status') == 'redirect':
        app = res.get('app')
        if not isinstance(app, str) or not APP_ID.match(app):
            return 'bad', None
        st, res = exchange(sock_path(f'askpass.{app}'), msg)
        if st == 'unavailable':                 # that app's agent is gone: the first agent answers itself
            st, res = exchange(sock_path(), dict(msg, routed=True))
    if st != 'ok':
        return st, None
    status = res.get('status')
    pw = res.get('password') if status == 'ok' else None
    if status == 'ok' and isinstance(pw, str) and '\n' not in pw:
        return 'ok', pw
    return (status if isinstance(status, str) else 'bad'), None


def main(argv):
    prompt = argv[1] if len(argv) > 1 else 'Password:'
    status, pw = ask(prompt)
    if status == 'ok':
        sys.stdout.write(pw + '\n')
        sys.stdout.flush()
        return 0
    if status == 'unavailable':
        return fallback(argv[1:])
    return 1


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv))
    except KeyboardInterrupt:
        sys.exit(1)
