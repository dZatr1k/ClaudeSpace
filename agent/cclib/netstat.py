"""Listening TCP sockets of this user, from /proc (no `ss`/`netstat`, stdlib only).

/proc/net/tcp{,6}: local address (hex, host byte order per 32-bit word), state 0A = LISTEN, uid, inode.
Inodes are mapped to pids through /proc/<pid>/fd/* -> 'socket:[inode]' (only this user's processes are readable).
Used for the reverse tunnel check (BACKLOG 12: is 127.0.0.1:2222 taken?) and the «Порты» panel (BACKLOG 10).
"""
import ipaddress
import os

LISTEN = '0A'
PROC = '/proc'
LOOPBACK_OR_ANY = ('127.0.0.1', '0.0.0.0', '::1', '::', '::ffff:127.0.0.1', '::ffff:0.0.0.0')


def _addr(hexaddr, v6):
    raw = bytes.fromhex(hexaddr)
    if not v6:
        return str(ipaddress.IPv4Address(raw[::-1]))
    # four 32-bit words, each in host (little-endian) order
    b = b''.join(raw[i:i + 4][::-1] for i in range(0, 16, 4))
    a = ipaddress.IPv6Address(b)
    return '::ffff:' + str(a.ipv4_mapped) if a.ipv4_mapped else str(a)


def parse_tcp(text, v6=False):
    """Rows of /proc/net/tcp(6): [{addr, port, state, uid, inode}] (header skipped, bad rows ignored)."""
    out = []
    for line in text.splitlines()[1:]:
        f = line.split()
        if len(f) < 10 or ':' not in f[1]:
            continue
        try:
            hexaddr, hexport = f[1].split(':')
            out.append({'addr': _addr(hexaddr, v6), 'port': int(hexport, 16), 'state': f[3].upper(),
                        'uid': int(f[7]), 'inode': int(f[9])})
        except ValueError:
            continue
    return out


def _read(path):
    try:
        with open(path, encoding='ascii', errors='replace') as f:
            return f.read()
    except OSError:
        return ''


def listening(uid=None):
    """LISTEN sockets (IPv4 + IPv6); uid filters to sockets owned by that user."""
    rows = [r for r in parse_tcp(_read(os.path.join(PROC, 'net', 'tcp'))) if r['state'] == LISTEN]
    rows += [r for r in parse_tcp(_read(os.path.join(PROC, 'net', 'tcp6')), True) if r['state'] == LISTEN]
    if uid is not None:
        rows = [r for r in rows if r['uid'] == uid]
    return rows


def is_listening(port, addrs=('127.0.0.1', '0.0.0.0', '::ffff:127.0.0.1', '::ffff:0.0.0.0')):
    return any(r['port'] == port and r['addr'] in addrs for r in listening())


def socket_owners(inodes, uid=None):
    """inode -> pid for the given socket inodes, scanning only processes of `uid` (default: this user)."""
    uid = os.getuid() if uid is None else uid
    want = {f'socket:[{i}]': i for i in inodes}
    res = {}
    if not want:
        return res
    try:
        pids = [d for d in os.listdir(PROC) if d.isdigit()]
    except OSError:
        return res
    for pid in pids:
        base = os.path.join(PROC, pid)
        try:
            if os.stat(base).st_uid != uid:
                continue
            fds = os.listdir(os.path.join(base, 'fd'))
        except OSError:
            continue
        for fd in fds:
            try:
                link = os.readlink(os.path.join(base, 'fd', fd))
            except OSError:
                continue
            ino = want.get(link)
            if ino is not None and ino not in res:
                res[ino] = int(pid)
        if len(res) == len(want):
            break
    return res


def proc_info(pid):
    """{name, cmd, cwd} of a process (best effort)."""
    base = os.path.join(PROC, str(pid))
    comm = _read(os.path.join(base, 'comm')).strip()
    try:
        with open(os.path.join(base, 'cmdline'), 'rb') as f:
            argv = [a.decode('utf-8', 'replace') for a in f.read().split(b'\0') if a]
    except OSError:
        argv = []
    try:
        cwd = os.readlink(os.path.join(base, 'cwd'))
    except OSError:
        cwd = None
    return {'comm': comm, 'name': display_name(comm, argv), 'argv': argv, 'cwd': cwd}


RUNTIMES = ('node', 'python', 'python3', 'bun', 'deno', 'npm', 'npx', 'pnpm', 'yarn', 'ruby', 'php', 'java')


def display_name(comm, argv):
    """'vite' for `node /…/node_modules/vite/bin/vite.js`, 'http.server' for `python3 -m http.server`, else comm."""
    base = os.path.basename(argv[0]) if argv else comm
    if not any(base == r or base.startswith(r + '.') or base.startswith(r + '3') for r in RUNTIMES):
        return comm or base
    args = argv[1:]
    for i, a in enumerate(args):
        if a == '-m' and i + 1 < len(args):
            return args[i + 1]
        if a.startswith('-'):
            continue
        if '/node_modules/' in a:
            rest = a.rsplit('/node_modules/', 1)[1].split('/')
            if rest and rest[0] == '.bin' and len(rest) > 1:
                return rest[1]
            if rest and rest[0].startswith('@') and len(rest) > 1:
                return rest[0] + '/' + rest[1]
            return rest[0] if rest else comm
        name = os.path.basename(a)
        for ext in ('.js', '.mjs', '.cjs', '.ts', '.py'):
            if name.endswith(ext):
                name = name[:-len(ext)]
        return name or comm
    return comm or base


SKIP_COMM = ('sshd', 'sshd-session', 'ssh')
EPHEMERAL_DEFAULT = (32768, 60999)


def ephemeral_range(path='/proc/sys/net/ipv4/ip_local_port_range'):
    """-> (lo, hi): the ports the kernel hands out for listen(0) / bind to port 0. Test runners and helper servers
    get these; dev servers listen on a fixed port."""
    try:
        lo, hi = (int(x) for x in _read(path).split()[:2])
        if 0 < lo <= hi <= 65535:
            return lo, hi
    except ValueError:
        pass
    return EPHEMERAL_DEFAULT


class PortScanner:
    """Listening TCP ports of this user's processes (BACKLOG 10). The inode -> pid scan over /proc/*/fd runs only
    when the set of listening sockets changed; process info is cached per (pid, inode)."""

    def __init__(self, home, skip_ports=(), ephemeral=None):
        self.home = home
        self.skip_ports = set(skip_ports)
        self.ephemeral = ephemeral or ephemeral_range()
        self.cache = {}         # inode -> port dict (or None = skip)

    def project_of(self, cwd):
        if not cwd:
            return None, None
        root = os.path.join(self.home, 'projects') + os.sep
        if cwd.startswith(root):
            name = cwd[len(root):].split(os.sep, 1)[0]
            return name, root + name
        return None, None

    def scan(self):
        rows = [r for r in listening(os.getuid()) if r['addr'] in LOOPBACK_OR_ANY and r['port'] not in self.skip_ports]
        inodes = {r['inode'] for r in rows}
        new = [i for i in inodes if i not in self.cache]
        if new:
            owners = socket_owners(new)
            for ino in new:
                pid = owners.get(ino)
                info = proc_info(pid) if pid else {'comm': '', 'name': '', 'cwd': None}
                if info['comm'] in SKIP_COMM:
                    self.cache[ino] = None
                    continue
                name, ppath = self.project_of(info['cwd'])
                self.cache[ino] = {'pid': pid, 'name': info['name'] or None, 'cwd': info['cwd'],
                                   'project': name, 'projectPath': ppath}
        for ino in list(self.cache):
            if ino not in inodes:
                del self.cache[ino]
        by_port = {}
        for r in sorted(rows, key=lambda r: (':' in r['addr'], r['addr'])):   # IPv4 first
            meta = self.cache.get(r['inode'])
            if meta is None or r['port'] in by_port:
                continue
            lo, hi = self.ephemeral
            by_port[r['port']] = dict(meta, port=r['port'], addr=r['addr'], ephemeral=lo <= r['port'] <= hi)
        return [by_port[p] for p in sorted(by_port)]
