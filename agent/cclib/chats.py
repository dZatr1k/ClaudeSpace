"""Chat transcripts (~/.claude/projects/*/*.jsonl): parsing, index cache, titles, tail, archive, aliases.

Ported from cc-menu ccdata.py (parse_chat, load_index, user_prompt, tail_dialog, move_chat) without terminal
formatting. Behaviour kept: project = folder encoded in the transcript directory name, sampled read of large
files (first + last 1 MB), titles custom > ai > summary > first prompt.
"""
import glob
import json
import os
import re
import threading
import time
from datetime import datetime

from . import paths
from .paths import safe_open

INDEX_VERSION = 3          # same layout as ccdata INDEX_VERSION 3 (+ extra keys), own file under ~/.cache/claudespace
HEAD_BYTES = 1 << 20
TAIL_BYTES = 1 << 20
NOISE = re.compile(r'^(<|Caveat:|\[Request interrupted)')
WRITE_EVERY = 45.0         # the index file is a cache for the next start: a running chat changes it every few seconds
_lock = threading.RLock()
_mem = {'chats': None, 'dirty': False, 'written': 0.0}   # in-memory index between polls (agent is long-lived)


def parse_ts(s):
    if not isinstance(s, str):
        return None
    try:
        return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
    except ValueError:
        return None


def user_prompt(o):
    """Real typed prompt from a 'user' line, or '' for tool results / meta / reminders."""
    if o.get('isMeta') or o.get('isSidechain'):
        return ''
    m = o.get('message')
    if not isinstance(m, dict):
        return ''
    ct = m.get('content')
    texts = []
    if isinstance(ct, str):
        texts = [ct]
    elif isinstance(ct, list):
        for x in ct:
            if isinstance(x, dict) and x.get('type') == 'tool_result':
                return ''
            if isinstance(x, dict) and x.get('type') == 'text':
                texts.append(x.get('text') or '')
    for t in texts:
        t = t.strip()
        if t and not NOISE.match(t):
            return t
    return ''


def read_parts(path, size):
    with safe_open(path, 'rb') as f:
        if size <= HEAD_BYTES + TAIL_BYTES:
            return [f.read()], False
        head = f.read(HEAD_BYTES)
        head = head[:head.rfind(b'\n') + 1]
        f.seek(size - TAIL_BYTES)
        tail = f.read()
        tail = tail[tail.find(b'\n') + 1:]
        return [head, tail], True


def encode_dir(d):
    """How Claude Code names a project's transcript folder: every non-alphanumeric char -> '-'."""
    return re.sub(r'[^A-Za-z0-9]', '-', d)


def parse_chat(path, st):
    info = dict(path=path, sid=os.path.basename(path)[:-6], mtime=st.st_mtime, size=st.st_size,
                cwd=None, first_ts=None, last_ts=None, title=None, title_src=None, custom_title=None,
                prompt=None, prompts=0, branch=None, added=None, removed=None, version=None, sampled=False,
                found=dict(sessionId=0, cwd=0, timestamp=0, user=0, title=0, gitBranch=0, cost=0),
                types={}, bad=0)
    try:
        parts, info['sampled'] = read_parts(path, st.st_size)
    except OSError:
        return info
    fnd = info['found']
    cwds = set()
    for part in parts:
        for raw in part.splitlines():
            if not raw.strip():
                continue
            try:
                o = json.loads(raw)
            except ValueError:
                info['bad'] += 1
                continue
            if not isinstance(o, dict):
                continue
            t = o.get('type')
            info['types'][str(t)] = info['types'].get(str(t), 0) + 1
            if o.get('sessionId'):
                fnd['sessionId'] += 1
            if o.get('cwd'):
                fnd['cwd'] += 1
                info['cwd'] = info['cwd'] or o['cwd']
                cwds.add(o['cwd'])
            ts = parse_ts(o.get('timestamp'))
            if ts:
                fnd['timestamp'] += 1
                info['first_ts'] = info['first_ts'] or ts
                info['last_ts'] = ts
            if o.get('gitBranch'):
                fnd['gitBranch'] += 1
                info['branch'] = o['gitBranch']
            if o.get('version'):
                info['version'] = o['version']
            if t == 'user':
                p = user_prompt(o)
                if p:
                    fnd['user'] += 1
                    info['prompts'] += 1
                    info['prompt'] = info['prompt'] or p[:300]
            elif t == 'ai-title' and o.get('aiTitle'):
                fnd['title'] += 1
                info['title'], info['title_src'] = o['aiTitle'], 'ai'
            elif t == 'custom-title' and o.get('customTitle'):
                fnd['title'] += 1
                info['custom_title'] = o['customTitle']
            elif t == 'summary' and o.get('summary'):
                fnd['title'] += 1
                if not info['title']:
                    info['title'], info['title_src'] = o['summary'], 'summary'
            elif t == 'cost-state':
                fnd['cost'] += 1
                try:
                    info['added'] = int(o.get('totalLinesAdded') or 0)
                    info['removed'] = int(o.get('totalLinesRemoved') or 0)
                except (TypeError, ValueError):
                    pass
    # 'cwd' in transcript lines follows `cd` inside the chat; the project is the folder the chat was started in
    enc = os.path.basename(os.path.dirname(path))
    root = next((d for d in cwds if encode_dir(d) == enc), None)
    if root:
        info['cwd'] = root
    if not info['last_ts']:
        info['last_ts'] = st.st_mtime
    return info


def _read_cache():
    try:
        with safe_open(paths.P.index) as f:
            idx = json.load(f)
        if idx.get('v') != INDEX_VERSION or not isinstance(idx.get('chats'), dict):
            raise ValueError
        return idx['chats']
    except (OSError, ValueError):
        return {}


def load_index():
    """All chats (active + archived) as raw dicts; re-parses only files whose mtime/size changed."""
    P = paths.P
    with _lock:
        old = _mem['chats'] if _mem['chats'] is not None else _read_cache()
        new, changed = {}, False
        for p in glob.glob(P.chats_glob) + glob.glob(P.archive_glob):
            try:
                st = os.stat(p)
            except OSError:
                continue
            c = old.get(p)
            if c and c['mtime'] == st.st_mtime and c['size'] == st.st_size and 'title_src' in c:
                new[p] = c
            else:
                new[p] = parse_chat(p, st)
                changed = True
        for p, c in new.items():
            c['archived'] = p.startswith(P.archive_dir + os.sep)
        _mem['chats'] = new
        if changed or len(new) != len(old):
            _mem['dirty'] = True
        if _mem['dirty'] and time.time() - _mem['written'] >= WRITE_EVERY:
            flush_index()
        return list(new.values())


def flush_index():
    """Write the in-memory index to disk if it changed since the last write (load_index does it at most every
    WRITE_EVERY seconds; the agent calls this on exit)."""
    with _lock:
        if not _mem['dirty'] or _mem['chats'] is None:
            return
        _mem['dirty'], _mem['written'] = False, time.time()
        try:
            paths.atomic_write_json(paths.P.index, {'v': INDEX_VERSION, 'chats': _mem['chats']})
        except OSError:
            pass


def reset_memory():
    with _lock:
        _mem.update(chats=None, dirty=False, written=0.0)


def visible(chats):
    return [c for c in chats if c.get('prompts') or c.get('title') or c.get('custom_title')]


def find(sid):
    return next((c for c in load_index() if c['sid'] == sid), None)


# ------------------------------------------------------------------ aliases (our renames; transcript untouched)
def load_titles():
    try:
        with safe_open(paths.P.titles) as f:
            d = json.load(f)
        return {k: v for k, v in d.items() if isinstance(v, str)} if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def set_title(sid, title):
    with _lock:
        d = load_titles()
        if title:
            d[sid] = title
        else:
            d.pop(sid, None)
        paths.atomic_write_json(paths.P.titles, d)


def pick_title(c, aliases=None):
    """-> (title, source). Order: custom > alias > ai > summary > first prompt > none."""
    aliases = aliases if aliases is not None else load_titles()
    if c.get('custom_title'):
        return c['custom_title'], 'custom'
    if aliases.get(c['sid']):
        return aliases[c['sid']], 'alias'
    if c.get('title'):
        return c['title'], c.get('title_src') or 'ai'
    if c.get('prompt'):
        return '"' + c['prompt'].splitlines()[0][:200] + '"', 'prompt'
    return '‹без названия›', 'none'


def ms(ts):
    return int(ts * 1000) if ts else None


def to_model(c, open_info=None, aliases=None):
    """Raw index entry -> Chat (camelCase, see src/shared/model.ts)."""
    title, src = pick_title(c, aliases)
    return {
        'id': c['sid'], 'project': c.get('cwd'), 'title': title, 'titleSource': src,
        'firstPrompt': c.get('prompt'), 'prompts': c.get('prompts', 0), 'promptsApprox': bool(c.get('sampled')),
        'branch': c.get('branch'), 'linesAdded': c.get('added'), 'linesRemoved': c.get('removed'),
        'firstAt': ms(c.get('first_ts')), 'lastAt': ms(c.get('last_ts')) or 0, 'sizeBytes': c.get('size', 0),
        'claudeVersion': c.get('version'), 'archived': bool(c.get('archived')), 'open': open_info,
    }


# ------------------------------------------------------------------ tail
def tail_dialog(path, n=6, max_chars=2000):
    """Last n messages [{role, text, at}] from the transcript tail."""
    try:
        size = os.path.getsize(path)
        with safe_open(path, 'rb') as f:
            f.seek(max(0, size - 512 * 1024))
            data = f.read()
    except OSError:
        return []
    msgs = []
    for raw in data.splitlines():
        try:
            o = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(o, dict):
            continue
        at = ms(parse_ts(o.get('timestamp')))
        if o.get('type') == 'user':
            p = user_prompt(o)
            if p:
                msgs.append({'role': 'user', 'text': p[:max_chars], 'at': at})
        elif o.get('type') == 'assistant' and not o.get('isSidechain'):
            ct = (o.get('message') or {}).get('content')
            if isinstance(ct, list):
                t = ' '.join(x.get('text', '') for x in ct if isinstance(x, dict) and x.get('type') == 'text').strip()
                if t:
                    msgs.append({'role': 'assistant', 'text': t[:max_chars], 'at': at})
    return msgs[-n:]


def _int(v):
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else 0


def tail_info(path, steps=(256 * 1024, 2 * 1024 * 1024), max_chars=500):
    """Cheap facts from the transcript tail (never the whole file): last real user prompt, model and token usage
    of the last main-chain assistant message. Reads the last 256 KB, then 2 MB if the prompt was not found.
    -> {lastPrompt: {text, at} | None, model: str | None, context: {tokens, output} | None}"""
    res = {'lastPrompt': None, 'model': None, 'context': None}
    try:
        size = os.path.getsize(path)
    except OSError:
        return res
    for step in steps:
        try:
            with safe_open(path, 'rb') as f:
                f.seek(max(0, size - step))
                data = f.read(step)
        except OSError:
            return res
        rows = data.splitlines()
        if size > step and rows:
            rows = rows[1:]                       # first line is cut
        for raw in reversed(rows):
            if res['lastPrompt'] and res['model']:
                break
            try:
                o = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(o, dict) or o.get('isSidechain'):
                continue
            t = o.get('type')
            if t == 'user' and not res['lastPrompt']:
                pr = user_prompt(o)
                if pr:
                    res['lastPrompt'] = {'text': pr[:max_chars], 'at': ms(parse_ts(o.get('timestamp')))}
            elif t == 'assistant' and not res['model']:
                m = o.get('message')
                if not isinstance(m, dict) or not isinstance(m.get('model'), str) or m['model'].startswith('<'):
                    continue                      # '<synthetic>' messages carry no real model/usage
                res['model'] = m['model'][:100]
                u = m.get('usage')
                if isinstance(u, dict):
                    tokens = (_int(u.get('input_tokens')) + _int(u.get('cache_creation_input_tokens'))
                              + _int(u.get('cache_read_input_tokens')))
                    res['context'] = {'tokens': tokens, 'output': _int(u.get('output_tokens'))}
        if res['lastPrompt'] or size <= step:
            break
    return res


# ------------------------------------------------------------------ archive
class MoveError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def move_chat(sid, to_archive, is_open):
    """Move <id>.jsonl (+ <id>/ with subagent logs) between ~/.claude/projects and the archive (same dir as cc).
    is_open(sid) -> bool. Returns the moved raw entry (reloaded)."""
    P = paths.P
    with _lock:
        c = find(sid)
        if not c:
            raise MoveError('not_found', 'чат не найден')
        if bool(c.get('archived')) == to_archive:
            raise MoveError('exists', 'чат уже в архиве' if to_archive else 'чат не в архиве')
        if to_archive and is_open(sid):
            raise MoveError('chat_open', 'чат сейчас открыт, сначала закройте его сессию')
        src_dir = os.path.dirname(c['path'])
        proj = os.path.basename(src_dir)
        dst_dir = os.path.join(P.archive_dir if to_archive else os.path.join(P.claude_dir, 'projects'), proj)
        os.makedirs(dst_dir, exist_ok=True)
        moved = 0
        for name in (sid + '.jsonl', sid):
            sp, dp = os.path.join(src_dir, name), os.path.join(dst_dir, name)
            if os.path.exists(sp):
                if os.path.exists(dp):
                    raise MoveError('exists', f'уже существует: {dp}')
                os.rename(sp, dp)
                moved += 1
        if to_archive:
            try:
                os.rmdir(src_dir)        # only if it became empty
            except OSError:
                pass
        if not moved:
            raise MoveError('not_found', 'нечего переносить')
        return find(sid)
