"""VM stats: load, CPU, RAM, disk, uptime, claude-tmux service, mosh servers, top processes."""
import os
import signal
import subprocess
import time

from . import doctor

_prev_cpu = {'v': None}


def _run(cmd, timeout=3):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except (OSError, subprocess.SubprocessError):
        return ''


def _cpu_times():
    with open('/proc/stat') as f:
        parts = f.readline().split()[1:]
    vals = [int(x) for x in parts]
    idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
    return sum(vals), idle


def cpu_pct():
    try:
        total, idle = _cpu_times()
    except (OSError, ValueError, IndexError):
        return 0
    prev = _prev_cpu['v']
    _prev_cpu['v'] = (total, idle)
    if not prev:
        time.sleep(0.2)
        try:
            t2, i2 = _cpu_times()
        except (OSError, ValueError, IndexError):
            return 0
        prev, (total, idle) = (total, idle), (t2, i2)
        _prev_cpu['v'] = (t2, i2)
    dt, di = total - prev[0], idle - prev[1]
    return round(100 * (1 - di / dt)) if dt > 0 else 0


def mosh_servers():
    out = _run(['ps', '-u', str(os.getuid()), '-o', 'pid=,etimes=,args='])
    res = []
    for line in out.splitlines():
        f = line.split(None, 2)
        if len(f) == 3 and f[2].startswith('mosh-server'):
            try:
                res.append((int(f[0]), int(f[1])))
            except ValueError:
                pass
    return res


def ancestors(pid):
    res = set()
    while pid > 1:
        res.add(pid)
        try:
            with open(f'/proc/{pid}/stat') as f:
                pid = int(f.read().rsplit(')', 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            break
    return res


def mosh_list():
    mine = ancestors(os.getpid())
    return [{'pid': p, 'ageSec': age, 'current': p in mine} for p, age in mosh_servers()]


def mosh_kill_stale():
    killed = 0
    for s in mosh_list():
        if not s['current']:
            try:
                os.kill(s['pid'], signal.SIGTERM)
                killed += 1
            except OSError:
                pass
    return killed


def top_processes(n=10):
    out = _run(['ps', '-eo', 'pid=,pcpu=,pmem=,rss=,comm=', '--sort=-rss'])
    res = []
    for line in out.splitlines()[:n]:
        f = line.split(None, 4)
        if len(f) == 5:
            try:
                res.append({'pid': int(f[0]), 'cpu': float(f[1]), 'mem': float(f[2]), 'rssMb': int(f[3]) // 1024,
                            'command': f[4]})
            except ValueError:
                pass
    return res


def stats(top=False):
    try:
        with open('/proc/loadavg') as f:
            load = [float(x) for x in f.read().split()[:3]]
    except (OSError, ValueError):
        load = [0.0, 0.0, 0.0]
    mem_total = mem_avail = 0
    try:
        mi = {}
        with open('/proc/meminfo') as f:
            for line in f:
                k, v = line.split(':', 1)
                mi[k] = int(v.split()[0])
        mem_total, mem_avail = mi['MemTotal'], mi['MemAvailable']
    except (OSError, KeyError, ValueError):
        pass
    try:
        st = os.statvfs('/')
        disk = round(100 * (1 - st.f_bavail / st.f_blocks))
    except (OSError, ZeroDivisionError):
        disk = 0
    try:
        with open('/proc/uptime') as f:
            up = int(float(f.read().split()[0]))
    except (OSError, ValueError):
        up = 0
    svc = _run(['systemctl', '--user', 'is-active', 'claude-tmux.service'], timeout=2).strip() or 'unknown'
    res = {
        'load': load, 'cpuPct': cpu_pct(),
        'memPct': round(100 * (1 - mem_avail / mem_total)) if mem_total else 0,
        'memUsedMb': (mem_total - mem_avail) // 1024, 'memTotalMb': mem_total // 1024,
        'diskPct': disk, 'uptimeSec': up, 'claudeVersion': doctor.claude_version(), 'tmuxService': svc,
        'moshCount': len(mosh_servers()),
    }
    if top:
        res['top'] = top_processes()
    return res
