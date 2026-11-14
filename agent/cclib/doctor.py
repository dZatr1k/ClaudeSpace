"""Compatibility check with Claude Code's internal files (ported from ccdata: evaluate/quick_doctor/doctor).

No Telegram here (that stays in cc-menu). State is our own: ~/.local/state/claudespace/compat.json.
"""
import json
import os
import shutil
import subprocess
import time

from . import chats, paths, sessions
from .paths import safe_open

REQUIRED = ['sessionId', 'cwd', 'timestamp', 'user']
SOFT = ['title', 'gitBranch', 'cost']
FIELD_RU = {'sessionId': 'id чата', 'cwd': 'папка', 'timestamp': 'время', 'user': 'текст запросов',
            'title': 'названия чатов', 'gitBranch': 'git-ветка', 'cost': 'статистика строк'}


def claude_version():
    try:
        p = os.path.realpath(os.path.join(paths.P.local_bin, 'claude'))
        return os.path.basename(p) if os.path.exists(p) else None
    except OSError:
        return None


def _run(cmd, timeout=3):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except (OSError, subprocess.SubprocessError):
        return ''


def check_chats(n):
    cs = [c for c in chats.load_index() if c['size'] > 20 * 1024 and not c.get('archived')]
    cs.sort(key=lambda c: -c['mtime'])
    cs = cs[:n]
    if not cs:
        return [], {}, {}, set()
    miss_req = {f: sum(1 for c in cs if not c['found'].get(f)) for f in REQUIRED}
    miss_soft = {f: sum(1 for c in cs if not c['found'].get(f)) for f in SOFT}
    live = {p['chatId'] for p in sessions.live()}
    # cost-state is written only after a session ends/resumes: open chats can't miss it yet
    miss_soft['cost'] = sum(1 for c in cs if not c['found'].get('cost') and c['sid'] not in live)
    return cs, miss_req, miss_soft, live


def check_registry():
    """Fields we use from ~/.claude/sessions/*.json (live processes only)."""
    import glob
    live, missing = 0, set()
    for p in glob.glob(paths.P.sessions_glob):
        try:
            with safe_open(p) as f:
                s = json.load(f)
        except (OSError, ValueError):
            continue
        if not isinstance(s, dict) or not sessions.proc_alive(s.get('pid'), s.get('procStart')):
            continue
        live += 1
        for k in ('pid', 'sessionId', 'status', 'cwd'):
            if not s.get(k):
                missing.add(k)
    return live, missing


def evaluate(n):
    cs, mreq, msoft, live_ids = check_chats(n)
    probs, level = [], 'ok'
    if cs:
        half = max(1, (len(cs) + 1) // 2)
        bad_req = [f for f, m in mreq.items() if m >= half]
        bad_soft = [f for f, m in msoft.items() if m == len(cs)]
        if bad_req:
            level = 'error'
            probs.append('не читается: ' + ', '.join(FIELD_RU[f] for f in bad_req))
        if bad_soft:
            level = 'warn' if level == 'ok' else level
            probs.append('нет: ' + ', '.join(FIELD_RU[f] for f in bad_soft))
    live, smiss = check_registry()
    if live and smiss:
        level = 'warn' if level == 'ok' else level
        probs.append('статус сессий: нет ' + ', '.join(sorted(smiss)))
    return level, probs, dict(chats=cs, mreq=mreq, msoft=msoft, live=live, smiss=smiss, live_ids=live_ids)


def load_compat():
    try:
        with safe_open(paths.P.compat) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save_compat(d):
    try:
        paths.atomic_write_json(paths.P.compat, d)
    except OSError:
        pass


def write_log(ver, level, probs, det):
    try:
        os.makedirs(paths.P.cache, exist_ok=True)
        with open(paths.P.doctor_log, 'a', encoding='utf-8') as f:
            f.write(f"\n=== {time.strftime('%F %T')} Claude Code {ver}: {level} {'; '.join(probs)}\n")
            for c in det.get('chats', []):
                f.write(f"  {c['sid']} size={c['size']} found={c['found']} bad_lines={c['bad']}\n")
    except OSError:
        pass


def quick():
    """-> {level, message} (level ok|warn|error)."""
    ver = claude_version()
    comp = load_compat()
    if ver and comp.get('version') != ver:
        level, probs, det = evaluate(5)
        write_log(ver, level, probs, det)
        comp = dict(version=ver, level=level, problems=probs, checked=int(time.time()),
                    known_good=ver if level == 'ok' else comp.get('known_good'))
        save_compat(comp)
    level, probs, _ = evaluate(2)
    if level == 'ok' and comp.get('level', 'ok') == 'ok':
        return {'level': 'ok', 'message': f'Claude Code {ver or "?"}: формат читается'}
    if level == 'ok':
        level, probs = comp.get('level'), comp.get('problems', [])
    kg = comp.get('known_good')
    hint = f' (работало на {kg})' if kg and kg != ver else ''
    return {'level': level, 'message': f"Claude Code {ver}: формат изменился — {'; '.join(probs)}{hint}"}


def _which(tool):
    return shutil.which(tool, path=paths.P.local_bin + os.pathsep + os.environ.get('PATH', ''))


def tools():
    res = []
    claude = _which('claude')
    help_ = _run([claude, '--help'], timeout=10) if claude else ''
    res.append({'name': 'claude --resume', 'ok': '--resume' in help_, 'detail': claude or 'claude не найден'})
    tv = _run(['tmux', '-V']).strip()
    res.append({'name': 'tmux', 'ok': bool(tv), 'detail': tv or 'tmux не найден'})
    for tool in ('lazygit', 'yazi', 'ccusage'):
        p = _which(tool)
        res.append({'name': tool, 'ok': bool(p), 'detail': p or 'не найден'})
    fv = (_run([_which('fzf') or 'fzf', '--version']).split() or ['?'])[0]
    try:
        fok = tuple(int(x) for x in fv.split('.')[:2]) >= (0, 63)
    except ValueError:
        fok = False
    res.append({'name': 'fzf', 'ok': fok, 'detail': f'{fv} (нужен для cc, ≥ 0.63)'})
    return res


def full():
    ver = claude_version()
    level, probs, det = evaluate(5)
    write_log(ver, level, probs, det)
    cs = det['chats']
    n = len(cs)
    fields = []
    for f in REQUIRED + SOFT:
        m = (det['mreq'] if f in REQUIRED else det['msoft']).get(f, 0)
        lv = 'ok' if m == 0 else ('fail' if f in REQUIRED and m >= max(1, (n + 1) // 2) else 'warn')
        opened = sum(1 for c in cs if c['sid'] in det['live_ids'] and not c['found'].get(f)) if f == 'cost' else 0
        fields.append({'key': f, 'label': FIELD_RU[f], 'level': lv, 'found': n - m - opened, 'total': n,
                       **({'note': f'{opened} в открытых чатах ещё не записано'} if opened else {})})
    comp = load_compat()
    comp.update(version=ver, level=level, problems=probs, checked=int(time.time()))
    if level == 'ok':
        comp['known_good'] = ver
    save_compat(comp)
    return {'level': level, 'claudeVersion': ver, 'knownGood': comp.get('known_good'), 'problems': probs,
            'fields': fields, 'registry': {'live': det['live'], 'missing': sorted(det['smiss'])},
            'tools': tools(), 'checkedAt': int(time.time() * 1000)}


def quick_model():
    q = quick()
    comp = load_compat()
    return {'level': q['level'], 'claudeVersion': claude_version(), 'knownGood': comp.get('known_good'),
            'problems': comp.get('problems', []) if q['level'] != 'ok' else [], 'fields': [],
            'registry': {'live': check_registry()[0], 'missing': []}, 'tools': [],
            'checkedAt': int(time.time() * 1000), 'message': q['message']}
