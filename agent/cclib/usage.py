"""ccusage: active 5-hour block + last 7 days (cached)."""
import json
import os
import shutil
import subprocess
import time

from . import paths
from .chats import parse_ts
from .paths import safe_open


def ccusage_path():
    return shutil.which('ccusage', path=paths.P.local_bin + os.pathsep + os.environ.get('PATH', ''))


def _env():
    # ccusage is a node script (#!/usr/bin/env node): node lives in ~/.local/bin too
    env = dict(os.environ)
    parts = env.get('PATH', '').split(os.pathsep)
    if paths.P.local_bin not in parts:
        env['PATH'] = os.pathsep.join([paths.P.local_bin] + [x for x in parts if x])
    return env


def _run(cmd, timeout=20):
    """stdout of a ccusage call; raises RuntimeError with a short reason if it failed or printed nothing."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=_env())
    except subprocess.TimeoutExpired:
        raise RuntimeError('ccusage не ответил за %d с' % timeout)
    except (OSError, subprocess.SubprocessError) as e:
        raise RuntimeError('ccusage не запустился: %s' % e)
    if r.returncode != 0 or not r.stdout.strip():
        err = (r.stderr or '').strip().splitlines()
        raise RuntimeError('ccusage: ' + (err[-1][:160] if err else 'код %d' % r.returncode))
    return r.stdout


def usage(max_age=60):
    P = paths.P
    try:
        if time.time() - os.path.getmtime(P.usage_cache) < max_age:
            with safe_open(P.usage_cache) as f:
                d = json.load(f)
            if isinstance(d, dict) and 'weekTokens' in d:
                return d
    except (OSError, ValueError):
        pass
    exe = ccusage_path()
    now = int(time.time() * 1000)
    if not exe:
        return {'ok': False, 'block': None, 'days': [], 'weekTokens': 0, 'at': now, 'error': 'ccusage не установлен'}
    since = time.strftime('%Y%m%d', time.localtime(time.time() - 6 * 86400))
    res = {'ok': False, 'block': None, 'days': [], 'weekTokens': 0, 'at': now}
    try:
        b = json.loads(_run([exe, 'blocks', '--active', '--json', '--offline']))
        d = json.loads(_run([exe, 'daily', '--json', '--offline', '--since', since]))
        blk = (b.get('blocks') or [None])[0]
        res.update(ok=True, weekTokens=(d.get('totals') or {}).get('totalTokens', 0) or 0)
        if blk:
            end = parse_ts(blk.get('endTime'))
            res['block'] = dict(tokens=blk.get('totalTokens', 0) or 0, costUsd=blk.get('costUSD', 0) or 0,
                                leftMin=max(0, int((end - time.time()) // 60)) if end else None,
                                models=blk.get('models', []) or [],
                                tpm=(blk.get('burnRate') or {}).get('tokensPerMinute'))
        for x in d.get('daily', []) or []:
            res['days'].append(dict(day=x.get('period') or x.get('date'), tokens=x.get('totalTokens', 0) or 0,
                                    costUsd=x.get('totalCost', 0) or 0))
    except RuntimeError as e:
        return {'ok': False, 'block': None, 'days': [], 'weekTokens': 0, 'at': now, 'error': str(e)}
    except (ValueError, TypeError, AttributeError):
        return {'ok': False, 'block': None, 'days': [], 'weekTokens': 0, 'at': now, 'error': 'ccusage: непонятный ответ'}
    try:  # only successful results are cached; a failure is retried on the next call
        paths.atomic_write_json(P.usage_cache, res)
    except OSError:
        pass
    return res


# ------------------------------------------------------------------ report for the «Расход» charts
REPORT_DAYS = (7, 14, 30)
TOP_PROJECTS = 8


def _num(x):
    return x if isinstance(x, (int, float)) and not isinstance(x, bool) else 0


def _report_cache(days):
    return os.path.join(paths.P.cache, f'usage-report-{days}.json')


def build_report(daily, sessions, blocks, chat_project, days, now=None):
    """Pure: ccusage JSON (daily --breakdown, session, blocks) -> the report. chat_project: chat id -> folder."""
    now = time.time() if now is None else now
    from . import projects as _projects   # display names
    first = time.strftime('%Y-%m-%d', time.localtime(now - (days - 1) * 86400))
    by_day = {}
    models = {}
    for x in (daily or {}).get('daily', []) or []:
        day = x.get('period') or x.get('date')
        if not isinstance(day, str) or day < first:
            continue
        mods = {}
        for m in x.get('modelBreakdowns') or []:
            name = str(m.get('modelName') or '?')
            tok = sum(_num(m.get(k)) for k in ('inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'))
            mods[name] = mods.get(name, 0) + tok
            agg = models.setdefault(name, {'name': name, 'tokens': 0, 'costUsd': 0.0})
            agg['tokens'] += tok
            agg['costUsd'] += _num(m.get('cost'))
        by_day[day] = {'day': day, 'tokens': _num(x.get('totalTokens')), 'costUsd': _num(x.get('totalCost')),
                       'models': mods}
    out_days = []
    for i in range(days):
        d = time.strftime('%Y-%m-%d', time.localtime(now - (days - 1 - i) * 86400))
        out_days.append(by_day.get(d) or {'day': d, 'tokens': 0, 'costUsd': 0, 'models': {}})
    projs = {}
    for s in (sessions or {}).get('session', []) or []:
        sid = s.get('period') or s.get('sessionId')
        folder = chat_project.get(sid)
        key = folder or ''
        p = projs.setdefault(key, {'folder': folder, 'label': _projects.display_name(folder) if folder else None,
                                   'tokens': 0, 'costUsd': 0.0, 'chats': 0})
        p['tokens'] += _num(s.get('totalTokens'))
        p['costUsd'] += _num(s.get('totalCost'))
        p['chats'] += 1
    plist = sorted(projs.values(), key=lambda p: -p['tokens'])
    named = [p for p in plist if p['folder']][:TOP_PROJECTS]
    rest = [p for p in plist if p not in named]
    if rest:
        named.append({'folder': None, 'label': None, 'tokens': sum(p['tokens'] for p in rest),
                      'costUsd': sum(p['costUsd'] for p in rest), 'chats': sum(p['chats'] for p in rest)})
    out_blocks, active = [], None
    for b in (blocks or {}).get('blocks', []) or []:
        if b.get('isGap'):
            continue
        start, end = parse_ts(b.get('startTime')), parse_ts(b.get('endTime'))
        if not start or not end:
            continue
        item = {'start': int(start * 1000), 'end': int(end * 1000), 'tokens': _num(b.get('totalTokens')),
                'costUsd': _num(b.get('costUSD')), 'active': bool(b.get('isActive'))}
        out_blocks.append(item)
        if item['active']:
            pr = b.get('projection') or {}
            active = dict(item, tpm=_num((b.get('burnRate') or {}).get('tokensPerMinute')) or None,
                          costPerHour=_num((b.get('burnRate') or {}).get('costPerHour')) or None,
                          leftMin=max(0, int((end - now) // 60)),
                          projectedTokens=_num(pr.get('totalTokens')) or None,
                          projectedCostUsd=_num(pr.get('totalCost')) or None,
                          models=[str(m) for m in b.get('models') or []])
    return {'ok': True, 'days': days, 'daily': out_days, 'projects': named,
            'models': sorted(models.values(), key=lambda m: -m['tokens']),
            'blocks': out_blocks[-12:], 'active': active,
            'totalTokens': sum(d['tokens'] for d in out_days), 'totalCostUsd': sum(d['costUsd'] for d in out_days),
            'at': int(now * 1000)}


def report(days=7, chat_project=None, max_age=120):
    """-> build_report(...) or {ok: False, error}; cached per period for max_age seconds."""
    days = days if days in REPORT_DAYS else 7
    cache = _report_cache(days)
    try:
        if time.time() - os.path.getmtime(cache) < max_age:
            with safe_open(cache) as f:
                d = json.load(f)
            if isinstance(d, dict) and d.get('ok'):
                return d
    except (OSError, ValueError):
        pass
    now = int(time.time() * 1000)
    exe = ccusage_path()
    if not exe:
        return {'ok': False, 'days': days, 'error': 'ccusage не установлен', 'at': now}
    since = time.strftime('%Y%m%d', time.localtime(time.time() - (days - 1) * 86400))
    try:
        daily = json.loads(_run([exe, 'daily', '--json', '--offline', '--breakdown', '--since', since], 40))
        sessions = json.loads(_run([exe, 'session', '--json', '--offline', '--since', since], 40))
        blocks = json.loads(_run([exe, 'blocks', '--json', '--offline', '--since', since], 40))
        res = build_report(daily, sessions, blocks, chat_project or {}, days)
    except RuntimeError as e:
        return {'ok': False, 'days': days, 'error': str(e), 'at': now}
    except (ValueError, TypeError, AttributeError):
        return {'ok': False, 'days': days, 'error': 'ccusage: непонятный ответ', 'at': now}
    try:
        paths.atomic_write_json(cache, res)
    except OSError:
        pass
    return res
