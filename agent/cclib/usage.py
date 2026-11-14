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
