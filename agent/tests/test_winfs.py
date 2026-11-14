"""«Диск ПК» (BACKLOG 12): winfs_* methods and pc_tunnel_status. The real winfs/fusermount3 are never run: a fake
HOME has fake `winfs` and `fusermount3` in ~/.local/bin that edit a fake mountinfo file (CSAGENT_MOUNTINFO)."""
import os
import socket
import sys
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
from cclib import paths, winfs  # noqa: E402
from tests import fixtures as fx  # noqa: E402

FAKE_WINFS = r'''#!/bin/sh
echo "winfs $*" >> "$HOME/calls.log"
[ "$1" = -u ] && exit 0
src=$1; dst=$2
mkdir -p "$dst"
[ -e "$HOME/winfs-fail" ] && { echo "read: Connection reset by peer" >&2; exit 1; }
esc=$(printf %s "$dst" | sed 's/ /\\040/g')
n=$(wc -l < "$CSAGENT_MOUNTINFO")
echo "$((100 + n)) 1 0:$((60 + n)) / $esc rw,nosuid - fuse.sshfs winpc:/$src rw,user_id=1000" >> "$CSAGENT_MOUNTINFO"
echo "mounted $src -> $dst"
'''

FAKE_FUSERMOUNT = r'''#!/bin/sh
echo "fusermount3 $*" >> "$HOME/calls.log"
for a; do dst=$a; done
[ -e "$HOME/fuse-busy" ] && { echo "fusermount3: failed to unmount $dst: Device or resource busy" >&2; exit 1; }
esc=$(printf %s "$dst" | sed 's/ /\\040/g')
grep -v " $esc rw" "$CSAGENT_MOUNTINFO" > "$CSAGENT_MOUNTINFO.tmp"; mv "$CSAGENT_MOUNTINFO.tmp" "$CSAGENT_MOUNTINFO"
'''


def make_fakes(fh):
    lb = os.path.join(fh.home, '.local', 'bin')
    for name, body in (('winfs', FAKE_WINFS), ('fusermount3', FAKE_FUSERMOUNT)):
        p = os.path.join(lb, name)
        with open(p, 'w') as f:
            f.write(body)
        os.chmod(p, 0o755)
    mi = os.path.join(fh.root, 'mountinfo')
    manual = os.path.join(fh.home, 'winfs', 'M')
    os.makedirs(manual)
    with open(mi, 'w') as f:
        f.write('22 1 8:1 / / rw,relatime - ext4 /dev/vda1 rw\n')
        f.write(f'50 22 0:50 / {manual} rw - fuse.sshfs winpc:/C:/Users rw\n')   # mounted by hand
    return mi, manual


class ValidationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fh = fx.FakeHome()
        paths.reset(cls.fh.home)

    @classmethod
    def tearDownClass(cls):
        cls.fh.cleanup()
        paths.reset()

    def test_src(self):
        self.assertEqual(winfs.norm_src('C:\\Data'), 'C:/Data')
        self.assertEqual(winfs.norm_src('c:/Data/'), 'C:/Data')
        self.assertEqual(winfs.norm_src('C:/Users/user/Мои документы'), 'C:/Users/user/Мои документы')
        self.assertEqual(winfs.norm_src('D:\\'), 'D:/')
        for bad in ('', 'Data', '/etc', '\\\\server\\share', 'C:/../Windows', 'C:/a/./b', 'C:/a;id', 'C:/$(id)',
                    'C:/a`id`', 'C:/a"b', 'C:/a|b', 'CC:/x', 'C:x', '-o C:/x', 'C:/a\nb', 'C:/' + 'x' * 300, 42, None):
            with self.assertRaises(winfs.WinfsError, msg=repr(bad)):
                winfs.norm_src(bad)

    def test_dst(self):
        h = self.fh.home
        self.assertEqual(winfs.norm_dst('~/winfs/V'), os.path.join(h, 'winfs', 'V'))
        self.assertEqual(winfs.norm_dst(h + '/winfs/docs/'), os.path.join(h, 'winfs', 'docs'))
        link = os.path.join(h, 'esc')
        os.symlink('/tmp', link)
        try:
            for bad in ('/tmp/x', '~', h, '~/.ssh/x', '~/.claude', '~/.local/bin', '~/winfs/../.ssh', 'winfs/V',
                        '~/esc/x', '~/esc', '~/projects/Alpha', '~/projects/Alpha/CLAUDE.md', 'x\0y', ''):
                with self.assertRaises(winfs.WinfsError, msg=bad):
                    winfs.norm_dst(bad)
        finally:
            os.unlink(link)

    def test_parse_mountinfo(self):
        ms = winfs.parse_mountinfo('36 25 0:32 / /home/u/winfs/My\\040Docs rw,nosuid shared:1 - fuse.sshfs '
                                   'winpc:/C:/Users rw,user_id=1000\nbroken line\n')
        self.assertEqual(ms, [{'id': '36', 'dst': '/home/u/winfs/My Docs', 'fstype': 'fuse.sshfs',
                               'source': 'winpc:/C:/Users'}])


class AgentWinfsTest(unittest.TestCase):
    def setUp(self):
        self.fh = fx.FakeHome()
        self.mi, self.manual = make_fakes(self.fh)
        self.env = {'CSAGENT_MOUNTINFO': self.mi}
        self.agents = []

    def tearDown(self):
        for a in self.agents:
            a.close()
        self.fh.cleanup()

    def agent(self):
        a = fx.AgentProc(self.fh, env=self.env)
        a.wait_event('winfs_changed')
        self.agents.append(a)
        return a

    def calls(self):
        try:
            with open(os.path.join(self.fh.home, 'calls.log')) as f:
                return f.read().splitlines()
        except OSError:
            return []

    def mounted(self):
        with open(self.mi) as f:
            return [ln.split()[4] for ln in f if 'fuse.sshfs' in ln]

    def ok(self, a, m, p):
        r = a.call(m, p, timeout=30)
        self.assertIn('result', r, r)
        return r['result']

    def test_mount_status_unmount(self):
        a = self.agent()
        v = os.path.join(self.fh.home, 'winfs', 'V')
        st = self.ok(a, 'winfs_status', {})
        self.assertTrue(st['winfs'])
        self.assertEqual(st['mounts'], [{'dst': self.manual, 'src': 'C:/Users', 'owned': False, 'client': None}])
        r = self.ok(a, 'winfs_mount', {'src': 'C:\\Data', 'dst': '~/winfs/V'})
        self.assertEqual(r, {'dst': v, 'src': 'C:/Data', 'owned': True, 'already': False, 'other': False})
        self.assertEqual(self.calls(), [f'winfs C:/Data {v}'])
        ev, _ = a.wait_event('winfs_changed', lambda d: any(m['dst'] == v for m in d['mounts']))
        self.assertTrue(next(m for m in ev['mounts'] if m['dst'] == v)['owned'])
        # second call: no-op, still ours
        r = self.ok(a, 'winfs_mount', {'src': 'C:/Data', 'dst': v})
        self.assertEqual((r['already'], r['owned']), (True, True))
        self.assertEqual(len(self.calls()), 1)
        # the manual mount: reported as not ours, never unmounted automatically
        r = self.ok(a, 'winfs_mount', {'src': 'C:/Users', 'dst': '~/winfs/M'})
        self.assertEqual((r['already'], r['owned']), (True, False))
        r = self.ok(a, 'winfs_unmount', {'dst': '~/winfs/M'})
        self.assertEqual(r['skipped'], 'manual')
        self.assertIn(self.manual, self.mounted())
        # busy -> clear error, still mounted
        open(os.path.join(self.fh.home, 'fuse-busy'), 'w').close()
        r = a.call('winfs_unmount', {'dst': '~/winfs/V'}, timeout=30)
        self.assertEqual(r['error']['code'], 'busy')
        self.assertIn('занят', r['error']['message'])
        os.unlink(os.path.join(self.fh.home, 'fuse-busy'))
        r = self.ok(a, 'winfs_unmount', {'dst': '~/winfs/V'})
        self.assertTrue(r['unmounted'])
        self.assertEqual(self.calls()[-1], f'fusermount3 -u {v}')
        self.assertNotIn(v, self.mounted())
        self.assertNotIn('winfs -u', '\n'.join(self.calls()))     # never the "unmount everything" form
        # explicit user unmount of a manual mount (onlyOwned=false) is allowed
        r = self.ok(a, 'winfs_unmount', {'dst': '~/winfs/M', 'onlyOwned': False})
        self.assertTrue(r['unmounted'])

    def test_bad_params_never_run_winfs(self):
        a = self.agent()
        bad = [{'src': 'C:/../x', 'dst': '~/winfs/V'}, {'src': 'C:/a;id', 'dst': '~/winfs/V'},
               {'src': '\\\\srv\\share', 'dst': '~/winfs/V'}, {'src': 'C:/Data', 'dst': '/tmp/x'},
               {'src': 'C:/Data', 'dst': '~/.ssh/x'}, {'src': 'C:/Data', 'dst': '~/projects/Alpha'},
               {'src': 'C:/Data', 'dst': '~'}, {'src': 'C:/Data'}, {'src': 5, 'dst': '~/winfs/V'}]
        for p in bad:
            r = a.call('winfs_mount', p)
            self.assertIn(r['error']['code'], ('bad_request', 'not_allowed', 'exists'), (p, r))
        self.assertEqual(a.call('winfs_unmount', {'dst': '/'})['error']['code'], 'not_allowed')
        self.assertEqual(self.calls(), [])

    def test_mount_failure(self):
        a = self.agent()
        open(os.path.join(self.fh.home, 'winfs-fail'), 'w').close()
        r = a.call('winfs_mount', {'src': 'C:/Data', 'dst': '~/winfs/V'}, timeout=30)
        self.assertEqual(r['error']['code'], 'mount_failed')
        self.assertIn('Connection reset', r['error']['message'])

    def test_exit_unmounts_only_own(self):
        a = self.agent()
        v = os.path.join(self.fh.home, 'winfs', 'V')
        self.ok(a, 'winfs_mount', {'src': 'C:/Data', 'dst': '~/winfs/V'})
        self.agents.remove(a)
        self.assertEqual(a.close(), 0)
        self.assertNotIn(v, self.mounted())
        self.assertEqual(self.calls()[-1], f'fusermount3 -u -z {v}')
        self.assertIn(self.manual, self.mounted())

    def test_takeover_by_newer_agent(self):
        old = self.agent()
        v = os.path.join(self.fh.home, 'winfs', 'V')
        self.ok(old, 'winfs_mount', {'src': 'C:/Data', 'dst': '~/winfs/V'})
        new = self.agent()   # reconnect: the new agent claims the mount before the old one sees EOF
        r = self.ok(new, 'winfs_mount', {'src': 'C:/Data', 'dst': '~/winfs/V'})
        self.assertEqual((r['already'], r['owned']), (True, True))
        self.agents.remove(old)
        old.close()
        self.assertIn(v, self.mounted())
        self.agents.remove(new)
        new.close()
        self.assertNotIn(v, self.mounted())

    def test_other_client_keeps_hands_off(self):
        """BACKLOG 13: a second ClaudeSpace on the same VM (another client id) neither takes the mount over nor
        unmounts it, on exit or with onlyOwned; the owner's reconnect still takes it over."""
        pc = self.agent()
        v = os.path.join(self.fh.home, 'winfs', 'V')
        self.ok(pc, 'winfs_mount', {'src': 'C:/Data', 'dst': '~/winfs/V', 'client': 'pc-app'})
        st = {m['dst']: m for m in self.ok(pc, 'winfs_status', {})['mounts']}
        self.assertEqual((st[v]['owned'], st[v]['client']), (True, 'pc-app'))
        dev = self.agent()
        r = self.ok(dev, 'winfs_mount', {'src': 'C:/Data', 'dst': '~/winfs/V', 'client': 'dev-copy'})
        self.assertEqual((r['already'], r['owned'], r['other']), (True, False, True))
        r = self.ok(dev, 'winfs_unmount', {'dst': '~/winfs/V', 'onlyOwned': True, 'lazy': True, 'client': 'dev-copy'})
        self.assertEqual(r.get('skipped'), 'other')
        self.agents.remove(dev)
        dev.close()
        self.assertIn(v, self.mounted())
        again = self.agent()   # the PC app reconnects: same client, takes over
        r = self.ok(again, 'winfs_mount', {'src': 'C:/Data', 'dst': '~/winfs/V', 'client': 'pc-app'})
        self.assertEqual((r['owned'], r['other']), (True, False))
        self.agents.remove(pc)
        pc.close()
        self.assertIn(v, self.mounted())
        self.agents.remove(again)
        again.close()
        self.assertNotIn(v, self.mounted())


class TunnelStatusTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fh = fx.FakeHome()
        cls.ag = fx.AgentProc(cls.fh)
        cls.ag.wait_event('hello')

    @classmethod
    def tearDownClass(cls):
        cls.ag.close()
        cls.fh.cleanup()

    def serve(self, banner):
        s = socket.socket()
        s.bind(('127.0.0.1', 0))
        s.listen(4)

        def loop():
            while True:
                try:
                    c, _ = s.accept()
                except OSError:
                    return
                if banner:
                    c.sendall(banner)
                c.close()
        threading.Thread(target=loop, daemon=True).start()
        return s

    @staticmethod
    def stop(s):
        try:
            s.shutdown(socket.SHUT_RDWR)   # wakes the accept() thread; close() alone keeps the socket listening
        except OSError:
            pass
        s.close()

    def test_free_foreign_and_hung(self):
        s = self.serve(b'SSH-2.0-OpenSSH_for_Windows\r\n')
        port = s.getsockname()[1]
        r = self.ag.call('pc_tunnel_status', {'port': port})['result']
        self.assertEqual(r, {'port': port, 'listening': True, 'banner': True})
        r = self.ag.call('pc_tunnel_status', {'port': port, 'banner': False})['result']
        self.assertIsNone(r['banner'])
        self.stop(s)
        r = self.ag.call('pc_tunnel_status', {'port': port})['result']
        self.assertEqual((r['listening'], r['banner']), (False, None))
        s2 = self.serve(b'')      # accepts and closes: not an ssh server (a hung/foreign holder)
        r = self.ag.call('pc_tunnel_status', {'port': s2.getsockname()[1]})['result']
        self.assertEqual((r['listening'], r['banner']), (True, False))
        self.stop(s2)
        self.assertEqual(self.ag.call('pc_tunnel_status', {'port': 'x'})['error']['code'], 'bad_request')


if __name__ == '__main__':
    unittest.main()
