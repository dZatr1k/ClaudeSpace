"""Links from the VM open in the browser on the PC: the socket side of openurl.py.

Claude Code opens a clicked link with $BROWSER (else xdg-open, which fails in tmux without a desktop: «Couldn't open
your browser»). ClaudeSpace starts its chats with BROWSER=<agent dir>/openurl.py (tmux.claude_command). The script
connects to the socket served here and sends one JSON line {v, url}; the answer is one JSON line:
  {"status": "ok"}           -> the app was told; the script exits 0
  {"status": "bad"}          -> not an http(s) URL; exit 1
  {"status": "busy"}         -> too many links in a short time; exit 1
  {"status": "unavailable"}  -> no app: the script falls back to xdg-open on the VM desktop, if there is one
The agent emits `open_url` {url}; the renderer opens it as if the link had been clicked in the terminal
(src/renderer/lib/ports.ts openLink: localhost through a port forward, the rest with shell.openExternal in main).

The server is on for as long as the agent runs: the agent itself only runs while an app is connected.
"""
import os
import re
import time

from . import appsock

MAX_URL = 4096           # the same limit as IPC launch.openExternal
BURST = 10               # links per WINDOW seconds; more is a runaway script, not a person clicking
WINDOW = 10.0
SCRIPT = 'openurl.py'
WEB_URL = re.compile(r'https?://[^/?#]+', re.IGNORECASE)     # scheme and a non-empty host


def script_path():
    """The installed helper next to the agent (agent dir/openurl.py), None when it is missing or not executable."""
    p = os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(__file__))), SCRIPT)
    return p if os.path.isfile(p) and os.access(p, os.X_OK) else None


def clean_url(v):
    """An absolute http(s) URL as given, or None. No spaces or control characters: they never belong in a URL and
    could hide a different address behind the one shown."""
    if not isinstance(v, str) or not v or len(v) > MAX_URL:
        return None
    if any(ch <= ' ' or ch == '\x7f' for ch in v):
        return None
    return v if WEB_URL.match(v) else None


class OpenUrlServer(appsock.AppSocket):
    """emit(event, data) sends to the app."""

    name = 'openurl'

    def __init__(self, emit, log=lambda *a: None, path=None, clock=time.monotonic, app_id=None, router=None):
        super().__init__(log=log, path=path, app_id=app_id, router=router)
        self.emit = emit
        self.clock = clock
        self.recent = []            # times of the last links, for BURST

    def on_message(self, conn, pid, msg):
        url = clean_url(msg.get('url'))
        if url is None:
            appsock.send_line(conn, {'status': 'bad'})
            return
        now = self.clock()
        with self.lock:
            self.recent = [t for t in self.recent if now - t < WINDOW]
            busy = len(self.recent) >= BURST
            if not busy:
                self.recent.append(now)
        if busy:
            self.log('openurl: too many links, refused one')
            appsock.send_line(conn, {'status': 'busy'})
            return
        self.emit('open_url', {'url': url})
        self.log('openurl: sent a link to the app')      # not the URL itself: it may carry tokens
        appsock.send_line(conn, {'status': 'ok'})
