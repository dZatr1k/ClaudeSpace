#!/usr/bin/env -S python3 -I
"""ClaudeSpace $BROWSER for chats on the VM: a link opens in the browser on the PC.

ClaudeSpace starts its Claude Code chats with BROWSER set to this script, so a link clicked in Claude Code (and
anything else that honours $BROWSER: gh, python -m webbrowser) comes here with the URL as the argument. The running
agent serves a unix socket (~/.cache/claudespace/run/openurl.sock, 0600, same uid only); we send the URL and the app
opens it.
- the app took it -> exit 0;
- no socket or no app listening -> xdg-open on the VM desktop if there is one (DISPLAY/WAYLAND_DISPLAY), with BROWSER
  removed so that xdg-open does not call us again; else exit 1 and the caller says it could not open a browser.
Several apps on this VM (the PC and the phone): the agent may answer {"status": "redirect", "app": ID}, the link
belongs to another app, and we repeat it on that app's socket openurl.<ID>.sock (cclib/route.py decides).
Stdlib only, no imports from the agent.
"""
import json
import os
import re
import shutil
import socket
import sys


APP_ID = re.compile(r'^[0-9a-f]{16}$')


def sock_path(name='openurl'):
    cache = os.environ.get('XDG_CACHE_HOME') or os.path.join(os.path.expanduser('~'), '.cache')
    return os.path.join(cache, 'claudespace', 'run', f'{name}.sock')


def exchange(path, msg):
    """One request on one socket -> the answer (a dict), or None when nobody listens there or nothing came back."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.settimeout(3)
        try:
            s.connect(path)
        except OSError:
            return None                         # no agent (never started, or a stale socket of a dead one)
        s.sendall(json.dumps(msg, ensure_ascii=False).encode('utf-8') + b'\n')
        buf = b''
        while b'\n' not in buf and len(buf) < 4096:
            try:
                chunk = s.recv(4096)
            except OSError:
                return None
            if not chunk:
                return None
            buf += chunk
    finally:
        s.close()
    try:
        res = json.loads(buf.split(b'\n', 1)[0].decode('utf-8'))
    except ValueError:
        return {'status': 'bad'}
    return res if isinstance(res, dict) else {'status': 'bad'}


def send(url):
    """-> the agent's status: 'ok' | 'bad' | 'busy' | 'unavailable' (also: no socket, or no answer)."""
    msg = {'v': 1, 'url': url, 'pane': os.environ.get('TMUX_PANE') or None, 'tmux': os.environ.get('TMUX') or None,
           'app': os.environ.get('CLAUDESPACE_APP') or None}
    res = exchange(sock_path(), msg)
    if res is not None and res.get('status') == 'redirect':
        app = res.get('app')
        if not isinstance(app, str) or not APP_ID.match(app):
            return 'bad'
        res = exchange(sock_path(f'openurl.{app}'), msg)
        if res is None:                         # that app's agent is gone: the first agent answers itself
            res = exchange(sock_path(), dict(msg, routed=True))
    if res is None:
        return 'unavailable'
    status = res.get('status')
    return status if isinstance(status, str) else 'bad'


def fallback(url):
    """No ClaudeSpace: the VM's own browser, when there is a desktop to show it on."""
    has_display = bool(os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY'))
    opener = shutil.which('xdg-open')
    if has_display and opener:
        env = {k: v for k, v in os.environ.items() if k != 'BROWSER'}
        try:
            os.execve(opener, [opener, url], env)
        except OSError as e:
            sys.stderr.write(f'claudespace-openurl: {opener}: {e}\n')
            return 1
    sys.stderr.write('claudespace-openurl: ClaudeSpace не подключено, а браузера на этой машине нет\n')
    return 1


def main(argv):
    # $BROWSER is run with one URL
    if len(argv) < 2 or not argv[1]:
        sys.stderr.write('usage: openurl.py URL\n')
        return 2
    url = argv[1]
    status = send(url)
    if status == 'ok':
        return 0
    if status == 'unavailable':
        return fallback(url)
    sys.stderr.write(f'claudespace-openurl: {status}\n')
    return 1


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv))
    except KeyboardInterrupt:
        sys.exit(1)
