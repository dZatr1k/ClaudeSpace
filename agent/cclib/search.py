"""Full-text search through chat transcripts (stage 6): ~/.claude/projects/*/*.jsonl and the archive.

Only what was said is searched: the user's typed prompts and Claude's text answers — not tool calls/results (file
contents, command output), not thinking, not meta lines. Files are streamed line by line (never read whole); a cheap
substring test on the raw line comes first, JSON is parsed only for lines that may match. Newest chats first.

Bounded: at most `limit` chats with hits, MAX_PER_CHAT snippets per chat, `budget` seconds in total; a new search
cancels the running one, and search_cancel stops it. Results stream as events:
  search_hits {searchId, hits: [Hit]}      (batched, at most every BATCH_SEC)
  search_done {searchId, scanned, total, found, truncated, timedOut, cancelled, ms}
Every open goes through paths.safe_open (deny-list) and the process audit hook.
"""
import json
import threading
import time

from . import chats
from .paths import safe_open

MAX_PER_CHAT = 3
SNIPPET = 160
BATCH_SEC = 0.25
MAX_QUERY = 200


def texts_of(o):
    """[(role, text)] said in this transcript line: user prompts and assistant text blocks only."""
    if not isinstance(o, dict) or o.get('isMeta') or o.get('isSidechain'):
        return []
    t = o.get('type')
    m = o.get('message')
    if t not in ('user', 'assistant') or not isinstance(m, dict):
        return []
    ct = m.get('content')
    if t == 'user':
        p = chats.user_prompt(o)
        return [('user', p)] if p else []
    out = []
    if isinstance(ct, str):
        out.append(('assistant', ct))
    elif isinstance(ct, list):
        for x in ct:
            if isinstance(x, dict) and x.get('type') == 'text' and isinstance(x.get('text'), str):
                out.append(('assistant', x['text']))
    return out


def snippet(text, start, length, width=SNIPPET):
    """~width chars around text[start:start+length], one line; -> {text, match: [s, e]} (match within text)."""
    before = max(0, start - (width - length) // 3)
    end = min(len(text), before + max(width, length))
    before = max(0, min(before, end - width))
    piece = text[before:end]
    s, e = start - before, start - before + length
    flat = ''.join(' ' if ch in '\r\n\t' else ch for ch in piece)
    prefix = '…' if before > 0 else ''
    suffix = '…' if end < len(text) else ''
    return {'text': prefix + flat + suffix, 'match': [s + len(prefix), e + len(prefix)]}


def find_all(hay_lower, needle, limit):
    out, i = [], hay_lower.find(needle)
    while i >= 0 and len(out) < limit:
        out.append(i)
        i = hay_lower.find(needle, i + max(1, len(needle)))
    return out


class Matcher:
    """Case-insensitive matcher with a raw-line prefilter (bytes for ASCII queries, str otherwise)."""

    def __init__(self, query):
        self.q = query.lower()
        self.ascii = query.isascii()
        esc = json.dumps(self.q, ensure_ascii=False)[1:-1]     # how the text looks inside a JSON string
        self.raw = {self.q, esc}
        self.raw_b = {x.encode('utf-8') for x in self.raw}

    def maybe(self, raw):
        if self.ascii:
            low = raw.lower()
            return any(x in low for x in self.raw_b)
        low = raw.decode('utf-8', 'replace').lower()
        return any(x in low for x in self.raw)


def scan_file(path, matcher, cancelled, max_hits=MAX_PER_CHAT):
    """-> (count, [ {role, text, match, at} ]) for one transcript."""
    count, hits = 0, []
    with safe_open(path, 'rb') as f:
        for raw in f:
            if cancelled():
                break
            if not matcher.maybe(raw):
                continue
            try:
                o = json.loads(raw)
            except ValueError:
                continue
            for role, text in texts_of(o):
                low = text.lower()
                pos = find_all(low, matcher.q, max_hits + 50)
                if not pos:
                    continue
                count += len(pos)
                for p in pos:
                    if len(hits) >= max_hits:
                        break
                    sn = snippet(text, p, len(matcher.q))
                    hits.append(dict(sn, role=role, at=chats.ms(chats.parse_ts(o.get('timestamp')))))
    return count, hits


class Searcher:
    """One search at a time, in its own thread (not the agent's small pool)."""

    def __init__(self, emit, log=lambda *a: None):
        self.emit = emit
        self.log = log
        self.lock = threading.Lock()
        self.current = None         # (search_id, cancel Event)

    def start(self, search_id, query, limit=50, budget=10.0, archived=True):
        query = query.strip()
        ev = threading.Event()
        with self.lock:
            if self.current:
                self.current[1].set()
            self.current = (search_id, ev)
        threading.Thread(target=self._run, args=(search_id, query, limit, budget, archived, ev),
                         name='search', daemon=True).start()

    def cancel(self, search_id=None):
        with self.lock:
            if self.current and (search_id is None or self.current[0] == search_id):
                self.current[1].set()
                return True
        return False

    def _run(self, sid, query, limit, budget, archived, ev):
        t0 = time.time()
        res = {'searchId': sid, 'scanned': 0, 'total': 0, 'found': 0, 'truncated': False, 'timedOut': False,
               'cancelled': False}
        try:
            entries = [c for c in chats.load_index() if archived or not c.get('archived')]
            entries.sort(key=lambda c: -(c.get('last_ts') or c.get('mtime') or 0))
            res['total'] = len(entries)
            aliases = chats.load_titles()
            m = Matcher(query)
            batch, last = [], time.time()
            for c in entries:
                if ev.is_set():
                    res['cancelled'] = True
                    break
                if time.time() - t0 > budget:
                    res['timedOut'] = True
                    break
                try:
                    count, hits = scan_file(c['path'], m, ev.is_set)
                except OSError:
                    continue
                res['scanned'] += 1
                if hits:
                    model = chats.to_model(c, None, aliases)
                    batch.append({'chatId': c['sid'], 'title': model['title'], 'project': model['project'],
                                  'lastAt': model['lastAt'], 'archived': bool(c.get('archived')),
                                  'count': count, 'matches': hits})
                    res['found'] += 1
                if batch and time.time() - last >= BATCH_SEC:
                    self.emit('search_hits', {'searchId': sid, 'hits': batch})
                    batch, last = [], time.time()
                if res['found'] >= limit:
                    res['truncated'] = res['scanned'] < res['total']
                    break
            if ev.is_set() and not res['cancelled'] and res['scanned'] < res['total'] and not res['truncated']:
                res['cancelled'] = True
            if batch and not res['cancelled']:
                self.emit('search_hits', {'searchId': sid, 'hits': batch})
        except Exception as e:      # report, never kill the agent
            self.log('search failed:', type(e).__name__, e)
        finally:
            res['ms'] = int((time.time() - t0) * 1000)
            with self.lock:
                if self.current and self.current[1] is ev:
                    self.current = None
            self.emit('search_done', res)
