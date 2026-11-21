"""Polling costs (docs/PERF.md): git cache with a TTL, one tmux call per poll, cached systemctl, mosh from /proc,
LISTEN rows filtered before decoding, throttled chat index writes, quiet chat changes, ccusage at low priority."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
import csagent  # noqa: E402
from cclib import chats, netstat, paths, projects, system, tmux, usage  # noqa: E402
from tests import fixtures as fx  # noqa: E402


class GitCacheTest(unittest.TestCase):
    def setUp(self):
        self.fh = fx.FakeHome()
        paths.reset(self.fh.home)
        projects._git_cache.clear()
        self.calls = []
        self.real = projects.git_info
        projects.git_info = lambda d: self.calls.append(d) or {'branch': 'main', 'dirty': False, 'aheadBehind': ''}

    def tearDown(self):
        projects.git_info = self.real
        projects._git_cache.clear()
        paths.reset()
        self.fh.cleanup()

    def test_ttl_and_key(self):
        d, t = self.fh.alpha, 1000.0
        projects.git_info_cached(d, now=t)
        projects.git_info_cached(d, now=t + projects.GIT_TTL - 1)
        self.assertEqual(len(self.calls), 1)                     # cached
        projects.git_info_cached(d, now=t + projects.GIT_TTL + 1)
        self.assertEqual(len(self.calls), 2)                     # expired: an edit in the tree shows up
        projects.git_info_cached(d, live=True, now=t + projects.GIT_TTL + 2 + projects.GIT_TTL_LIVE)
        self.assertEqual(len(self.calls), 3)                     # a project with a session expires sooner

    def test_lock_files_in_git_dir_do_not_invalidate(self):
        d = self.fh.alpha
        projects.git_info_cached(d, now=1000.0)
        lock = os.path.join(d, '.git', 'index.lock')
        open(lock, 'w').close()
        os.remove(lock)                                          # .git's mtime changed, as after any git command
        projects.git_info_cached(d, now=1001.0)
        self.assertEqual(len(self.calls), 1)
        os.utime(os.path.join(d, '.git', 'HEAD'), (time.time() + 5, time.time() + 5))   # checkout
        projects.git_info_cached(d, now=1002.0)
        self.assertEqual(len(self.calls), 2)


class GitStatusNoLockTest(unittest.TestCase):
    def test_status_does_not_touch_git_dir(self):
        fh = fx.FakeHome()
        try:
            d = fh.alpha
            with open(os.path.join(d, 'new.txt'), 'w') as f:
                f.write('x')
            subprocess.run(['git', '-C', d, 'add', '.'], check=True, capture_output=True)
            git_dir = os.path.join(d, '.git')
            os.utime(os.path.join(d, 'new.txt'), (time.time() + 10, time.time() + 10))   # stale stat info in index
            before = (os.stat(git_dir).st_mtime_ns, os.stat(os.path.join(git_dir, 'index')).st_mtime_ns)
            self.assertIsNotNone(projects.git_info(d))
            after = (os.stat(git_dir).st_mtime_ns, os.stat(os.path.join(git_dir, 'index')).st_mtime_ns)
            self.assertEqual(before, after)                      # no index.lock, no index refresh
        finally:
            fh.cleanup()


class QuietChangeTest(unittest.TestCase):
    def test_only_size_and_time(self):
        old = {'id': 'a', 'title': 'x', 'sizeBytes': 1, 'lastAt': 1, 'prompts': 1}
        self.assertTrue(csagent.quiet_change(old, dict(old, sizeBytes=2, lastAt=2)))
        self.assertFalse(csagent.quiet_change(old, dict(old, prompts=2)))
        self.assertFalse(csagent.quiet_change(None, old))        # a new chat


class TmuxSnapshotTest(unittest.TestCase):
    def test_parse_takes_active_pane_of_active_window(self):
        rows = [
            ['%1', 'a', '0', '0', '1', '1', '100', '2', '/w0', 'bash'],
            ['%2', 'a', '1', '1', '0', '1', '100', '2', '/w1-p0', 'vim'],
            ['%3', 'a', '1', '1', '1', '1', '100', '2', '/w1-p1', 'claude'],
            ['%4', 'b', '0', '1', '1', '0', '200', '1', '/b', 'bash'],
            ['bad'],
        ]
        sess, panes = tmux.parse_snapshot('\n'.join('\t'.join(r) for r in rows))
        self.assertEqual([s['name'] for s in sess], ['a', 'b'])
        self.assertEqual((sess[0]['path'], sess[0]['command']), ('/w1-p1', 'claude'))
        self.assertEqual(sess[0]['activity'], 100000)
        self.assertEqual(panes['%2'], ('a', '1'))
        self.assertEqual(len(panes), 4)

    def test_same_as_list_sessions_on_real_tmux(self):
        fx.kill_tmux_server()
        os.environ['CSAGENT_TMUX_SOCKET'] = fx.TMUX_SOCKET
        try:
            home = tempfile.mkdtemp(prefix='cs-tmux-')
            fx.tmux('new-session', '-d', '-s', 'one', '-c', home, 'sleep 60')
            fx.tmux('new-window', '-t', '=one:', '-c', '/', 'sleep 61')
            fx.tmux('split-window', '-t', '=one:1', '-c', '/tmp', 'sleep 62')
            fx.tmux('new-session', '-d', '-s', 'two', '-c', home, 'sleep 63')
            fmt = '#{session_name}\t#{session_windows}\t#{pane_current_path}\t#{pane_current_command}'
            want = [line.split('\t') for line in fx.tmux('list-sessions', '-F', fmt).stdout.splitlines()]
            sess, panes = tmux.snapshot()
            got = [[s['name'], str(s['windows']), s['path'], s['command']] for s in sess]
            self.assertEqual(got, want)
            self.assertEqual(len(panes), 4)
        finally:
            os.environ.pop('CSAGENT_TMUX_SOCKET', None)
            fx.kill_tmux_server()
            shutil.rmtree(home, ignore_errors=True)


class SystemTest(unittest.TestCase):
    def test_service_state_cached(self):
        calls = []
        real = system._run
        system._run = lambda cmd, timeout=3: calls.append(cmd) or 'active\n'
        system._svc.update(value=None, at=0.0)
        try:
            self.assertEqual(system.service_state(now=100.0), 'active')
            system.service_state(now=100.0 + system.SVC_TTL - 1)
            self.assertEqual(len(calls), 1)
            system.service_state(now=100.0 + system.SVC_TTL + 1)
            self.assertEqual(len(calls), 2)
        finally:
            system._run = real
            system._svc.update(value=None, at=0.0)

    def test_mosh_servers_from_proc(self):
        tmp = tempfile.mkdtemp(prefix='cs-mosh-')
        exe = os.path.join(tmp, 'mosh-server')
        shutil.copy(shutil.which('sleep'), exe)
        p = subprocess.Popen([exe, '30'])
        try:
            for _ in range(50):
                found = dict(system.mosh_servers())
                if p.pid in found:
                    break
                time.sleep(0.05)
            self.assertIn(p.pid, found)
            self.assertLess(found[p.pid], 30)
            self.assertNotIn(os.getpid(), found)
        finally:
            p.kill()
            p.wait()
            shutil.rmtree(tmp, ignore_errors=True)


class ListenFilterTest(unittest.TestCase):
    TCP = ('  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
           '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1\n'
           '   1: 0100007F:1F90 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 222 1\n'
           '   2: ZZZZZZZZ:0050 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 333 1\n')

    def test_state_filter_skips_before_decoding(self):
        rows = netstat.parse_tcp(self.TCP, state=netstat.LISTEN)
        self.assertEqual([(r['addr'], r['port'], r['inode']) for r in rows], [('127.0.0.1', 8080, 111)])
        self.assertEqual(len(netstat.parse_tcp(self.TCP)), 2)    # unfiltered: the bad address row is still dropped


class IndexWriteTest(unittest.TestCase):
    def setUp(self):
        self.fh = fx.FakeHome()
        paths.reset(self.fh.home)
        chats.reset_memory()

    def tearDown(self):
        chats.reset_memory()
        paths.reset()
        self.fh.cleanup()

    def on_disk(self):
        with open(paths.P.index, encoding='utf-8') as f:
            return json.load(f)['chats']

    def test_written_at_most_every_interval_and_on_flush(self):
        chats.load_index()
        n = len(self.on_disk())
        p = self.fh.chat_path(self.fh.alpha, fx.uuid4())
        with open(p, 'w') as f:
            f.write(fx.user('новый чат', '2026-11-21T10:00:00Z', self.fh.alpha, os.path.basename(p)[:-6]))
        self.assertEqual(len(chats.load_index()), n + 1)          # in memory at once
        self.assertEqual(len(self.on_disk()), n)                  # the file waits for WRITE_EVERY
        chats.flush_index()
        self.assertEqual(len(self.on_disk()), n + 1)
        mtime = os.stat(paths.P.index).st_mtime_ns
        chats.flush_index()                                       # nothing new: no write
        self.assertEqual(os.stat(paths.P.index).st_mtime_ns, mtime)


class LowPriorityTest(unittest.TestCase):
    def test_prefix(self):
        pre = usage.low_priority()
        if shutil.which('nice'):
            self.assertEqual(pre[:3], ['nice', '-n', '10'])
        if shutil.which('ionice'):
            self.assertIn('ionice', pre)
            self.assertNotIn('3', pre[pre.index('ionice'):])      # never the idle class


if __name__ == '__main__':
    unittest.main()
