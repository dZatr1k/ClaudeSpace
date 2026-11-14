"""Turn-finished events written by the user's Claude Code hook (~/.claude/hooks/notify.sh → emit_claudespace).

One JSON line per event in ~/.cache/claudespace/events.jsonl:
  {"ts": ms, "kind": "done"|"input", "sessionId": "...", "cwd": "...", "project": "...", "body": "..."}
The hook trims the file (tail -n 200 + mv) when it grows past 1 MB, so the reader follows by offset and, after a
shrink or a replaced file, re-reads it and keeps only events newer than the last one delivered.
"""
import json
import os
import time

from . import paths
from .paths import safe_open

KINDS = ('done', 'input')
MAX_BODY = 300


def events_path():
    return os.path.join(paths.P.cache, 'events.jsonl')


def _clean(o):
    if not isinstance(o, dict) or o.get('kind') not in KINDS:
        return None
    ts = o.get('ts')
    if not isinstance(ts, (int, float)):
        return None
    sid = o.get('sessionId')
    body = o.get('body') if isinstance(o.get('body'), str) else ''
    # the hook prefixes ✅ / ⏳ for Telegram; the app has its own wording
    body = body.lstrip('✅⏳ ').strip()[:MAX_BODY]
    return {
        'ts': int(ts),
        'kind': o['kind'],
        'chatId': sid if isinstance(sid, str) and sid else None,
        'cwd': o.get('cwd') if isinstance(o.get('cwd'), str) else None,
        'project': o.get('project') if isinstance(o.get('project'), str) else None,
        'body': body,
    }


class TurnTail:
    """Delivers only events appended after start(); never replays history on (re)connect."""

    def __init__(self, path=None):
        self.path = path or events_path()
        self.offset = 0
        self.ino = None
        self.last_ts = 0

    def start(self):
        try:
            st = os.stat(self.path)
            self.offset, self.ino = st.st_size, st.st_ino
        except OSError:
            self.offset, self.ino = 0, None
        self.last_ts = int(time.time() * 1000)

    def read_new(self):
        try:
            st = os.stat(self.path)
        except OSError:
            return []
        if st.st_ino != self.ino or st.st_size < self.offset:
            self.ino, self.offset = st.st_ino, 0  # trimmed/replaced: re-read, filter by ts below
        if st.st_size == self.offset:
            return []
        out = []
        with safe_open(self.path, 'rb') as f:
            f.seek(self.offset)
            chunk = f.read(min(st.st_size - self.offset, 1024 * 1024))
        end = chunk.rfind(b'\n')
        if end < 0:
            return []  # a line is still being written
        self.offset += end + 1
        for line in chunk[:end].split(b'\n'):
            try:
                ev = _clean(json.loads(line))
            except ValueError:
                continue
            if ev and ev['ts'] > self.last_ts:
                self.last_ts = ev['ts']
                out.append(ev)
        return out
