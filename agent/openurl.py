#!/usr/bin/env -S python3 -I
"""ClaudeSpace $BROWSER for chats on the VM: a link opens in the browser on the PC.

ClaudeSpace starts its Claude Code chats with BROWSER set to this script, so a link clicked in Claude Code (and
anything else that honours $BROWSER: gh, python -m webbrowser) comes here with the URL as the argument. The running
agent serves a unix socket (~/.cache/claudespace/run/openurl.sock, 0600, same uid only); we send the URL and the app
opens it.
- the app took it -> exit 0;
- no socket or no app listening -> xdg-open on the VM desktop if there is one (DISPLAY/WAYLAND_DISPLAY), with BROWSER
  removed so that xdg-open does not call us again; else exit 1 and the caller says it could not open a browser.
Stdlib only, no imports from the agent.
"""
import json
import os
import shutil
import socket
import sys


def sock_path():
    cache = os.environ.get('XDG_CACHE_HOME') or os.path.join(os.path.expanduser('~'), '.cache')
    return os.path.join(cache, 'claudespace', 'run', 'openurl.sock')


def send(url):
    """-> the agent's status: 'ok' | 'bad' | 'busy' | 'unavailable' (also: no socket, or no answer)."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.settimeout(3)
        try:
            s.connect(sock_path())
        except OSError:
            return 'unavailable'                # no agent (never started, or a stale socket of a dead one)
        s.sendall(json.dumps({'v': 1, 'url': url}, ensure_ascii=False).encode('utf-8') + b'\n')
        buf = b''
        while b'\n' not in buf and len(buf) < 4096:
            try:
                chunk = s.recv(4096)
            except OSError:
                return 'unavailable'
            if not chunk:
                return 'unavailable'
            buf += chunk
    finally:
        s.close()
    try:
        res = json.loads(buf.split(b'\n', 1)[0].decode('utf-8'))
    except ValueError:
        return 'bad'
    status = res.get('status') if isinstance(res, dict) else None
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
