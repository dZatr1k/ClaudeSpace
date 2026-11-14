"""sudo prompts in the app (BACKLOG 11): askpass.py <-> unix socket <-> AskpassServer <-> the app (events/methods).

Runs the real script (shebang `env -S python3 -I`) against a server in a fake HOME. Covers: answer, cancel, timeout,
sudo interrupted, fallback to the user's GTK prompt (absent socket, stale socket, app not listening, no DISPLAY),
peer uid check, socket/dir permissions, several agents taking the path over, and the agent end to end (the password
never shows up in the agent's stderr)."""
import json
import os
import socket
import stat
import subprocess
import sys
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
from cclib import askpass, paths  # noqa: E402
from tests import fixtures as fx  # noqa: E402

SCRIPT = os.path.join(fx.AGENT_DIR, 'askpass.py')
PASSWORD = 'pa$$ wörd-SECRET-42'


class Events:
    def __init__(self):
        self.items = []
        self.cond = threading.Condition()

    def __call__(self, name, data):
        with self.cond:
            self.items.append((name, data))
            self.cond.notify_all()

    def wait(self, name, timeout=10):
        end = time.time() + timeout
        with self.cond:
            while True:
                for n, d in self.items:
                    if n == name:
                        self.items.remove((n, d))
                        return d
                left = end - time.time()
                if left <= 0:
                    raise TimeoutError(name)
                self.cond.wait(left)


class Base(unittest.TestCase):
    def setUp(self):
        self.fh = fx.FakeHome()
        paths.reset(self.fh.home)
        self.servers = []

    def tearDown(self):
        for s in self.servers:
            s.shutdown()
        paths.reset()
        self.fh.cleanup()

    def server(self, **kw):
        ev = Events()
        s = askpass.AskpassServer(ev, **kw)
        s.events = ev
        self.servers.append(s)
        return s

    def env(self, **extra):
        e = self.fh.env()
        e.pop('DISPLAY', None)
        e.pop('WAYLAND_DISPLAY', None)
        e.update(extra)
        return e

    def run_script(self, env=None, prompt='[sudo] пароль для claude:'):
        # through sh, as sudo would: the parent's command line is what the prompt shows
        return subprocess.Popen(['sh', '-c', '"$0" "$1"', SCRIPT, prompt], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env=env or self.env(TMUX_PANE='%7'), cwd=self.fh.alpha)

    def fake_gtk(self):
        p = os.path.join(self.fh.home, '.local', 'bin', 'sudo-askpass')
        with open(p, 'w') as f:
            f.write('#!/bin/sh\necho "GTK:$1"\n')
        os.chmod(p, 0o755)
        return p


class ProtocolTest(Base):
    def test_answer(self):
        s = self.server(session_of=lambda pane: 'alpha' if pane == '%7' else None)
        s.enable(True)
        p = self.run_script()
        req = s.events.wait('askpass_request')
        self.assertRegex(req['id'], r'^[0-9a-f]{16}$')
        self.assertEqual(req['prompt'], '[sudo] пароль для claude:')
        self.assertEqual(req['session'], 'alpha')
        self.assertEqual(req['cwd'], self.fh.alpha)
        self.assertIn('sh -c', req['command'])
        self.assertTrue(s.reply(req['id'], PASSWORD))
        out, err = p.communicate(timeout=10)
        self.assertEqual(p.returncode, 0, err)
        self.assertEqual(out.decode(), PASSWORD + '\n')
        self.assertFalse(s.reply(req['id'], 'again'))          # one answer per prompt
        self.assertEqual(s.pending, {})

    def test_cancel(self):
        s = self.server()
        s.enable(True)
        p = self.run_script()
        req = s.events.wait('askpass_request')
        s.reply(req['id'], None)
        out, _ = p.communicate(timeout=10)
        self.assertEqual((p.returncode, out), (1, b''))

    def test_timeout(self):
        s = self.server(timeout=0.6)
        s.enable(True)
        p = self.run_script()
        req = s.events.wait('askpass_request')
        done = s.events.wait('askpass_done')
        self.assertEqual(done, {'id': req['id'], 'reason': 'timeout'})
        out, _ = p.communicate(timeout=10)
        self.assertEqual((p.returncode, out), (1, b''))
        self.assertFalse(s.reply(req['id'], PASSWORD))

    def test_sudo_interrupted(self):
        s = self.server()
        s.enable(True)
        p = subprocess.Popen([SCRIPT, 'pw:'], env=self.env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        req = s.events.wait('askpass_request')
        p.kill()
        p.wait(5)
        done = s.events.wait('askpass_done')
        self.assertEqual(done, {'id': req['id'], 'reason': 'gone'})
        p.stdout.close()
        p.stderr.close()

    def test_disable_and_shutdown_cancel_waiting(self):
        for how in ('disable', 'shutdown'):
            s = self.server()
            s.enable(True)
            p = self.run_script()
            req = s.events.wait('askpass_request')
            s.enable(False) if how == 'disable' else s.shutdown()
            out, _ = p.communicate(timeout=10)
            self.assertEqual((p.returncode, out), (1, b''), how)
            self.assertFalse(s.reply(req['id'], PASSWORD))
            self.assertFalse(os.path.exists(askpass.sock_path()), how)

    def test_queue_limit(self):
        s = self.server()
        s.enable(True)
        procs = [self.run_script() for _ in range(askpass.MAX_PENDING)]
        ids = [s.events.wait('askpass_request')['id'] for _ in procs]
        extra = self.run_script()
        out, _ = extra.communicate(timeout=10)
        self.assertEqual((extra.returncode, out), (1, b''))      # busy -> sudo fails, no hang
        for rid in ids:
            s.reply(rid, None)
        for p in procs:
            p.communicate(timeout=10)

    def test_permissions(self):
        s = self.server()
        s.enable(True)
        st = os.stat(askpass.sock_path())
        self.assertTrue(stat.S_ISSOCK(st.st_mode))
        self.assertEqual(stat.S_IMODE(st.st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(askpass.run_dir()).st_mode), 0o700)

    def test_loose_dir_tightened_and_symlink_refused(self):
        d = askpass.run_dir()
        os.makedirs(d, mode=0o755)
        os.chmod(d, 0o755)
        s = self.server()
        s.enable(True)
        self.assertEqual(stat.S_IMODE(os.stat(d).st_mode), 0o700)
        s.shutdown()
        os.rmdir(d)
        os.symlink('/tmp', d)
        with self.assertRaises(askpass.AskpassError):
            askpass.ensure_private_dir(d)
        s2 = self.server()
        self.assertFalse(s2.enable(True)['listening'])          # refused, logged, no crash

    def test_peer_uid_checked(self):
        s = self.server()
        s.enable(True)
        real = askpass.peer_cred
        with mock.patch.object(askpass, 'peer_cred', lambda c: (lambda p, u, g: (p, u + 1, g))(*real(c))):
            p = self.run_script()
            out, _ = p.communicate(timeout=10)
        self.assertEqual((p.returncode, out), (1, b''))
        self.assertEqual(s.pending, {})
        with self.assertRaises(TimeoutError):
            s.events.wait('askpass_request', timeout=0.3)

    def test_bad_frames_do_not_break_server(self):
        s = self.server()
        s.enable(True)
        for junk in (b'not json\n', b'[1,2]\n', b'x' * (askpass.MAX_LINE + 10), b''):
            with socket.socket(socket.AF_UNIX) as c:
                c.connect(askpass.sock_path())
                c.sendall(junk)
                c.shutdown(socket.SHUT_WR)
                c.settimeout(5)
                self.assertEqual(c.recv(100), b'')
        p = self.run_script()
        req = s.events.wait('askpass_request')
        s.reply(req['id'], 'x')
        self.assertEqual(p.communicate(timeout=10)[0], b'x\n')


class FallbackTest(Base):
    def test_no_socket_uses_gtk_with_display(self):
        self.fake_gtk()
        p = self.run_script(env=self.env(DISPLAY=':99'))
        out, _ = p.communicate(timeout=10)
        self.assertEqual((p.returncode, out.decode()), (0, 'GTK:[sudo] пароль для claude:\n'))

    def test_no_socket_no_display_fails(self):
        self.fake_gtk()
        p = self.run_script()
        out, err = p.communicate(timeout=10)
        self.assertEqual((p.returncode, out), (1, b''))
        self.assertIn('ClaudeSpace', err.decode())

    def test_no_gtk_fails(self):
        p = self.run_script(env=self.env(DISPLAY=':99'))
        self.assertEqual(p.communicate(timeout=10)[0], b'')
        self.assertEqual(p.returncode, 1)

    def test_app_not_listening_falls_back(self):
        self.fake_gtk()
        s = self.server()
        s.enable(True)
        s.enabled = False            # socket still there, but the app has not enabled prompts (or turned them off)
        p = self.run_script(env=self.env(DISPLAY=':99'))
        out, _ = p.communicate(timeout=10)
        self.assertTrue(out.startswith(b'GTK:'))

    def test_stale_socket_falls_back_and_is_replaced(self):
        self.fake_gtk()
        askpass.ensure_private_dir(askpass.run_dir())
        dead = socket.socket(socket.AF_UNIX)
        dead.bind(askpass.sock_path())
        dead.close()                 # the file stays: an agent that was killed
        p = self.run_script(env=self.env(DISPLAY=':99'))
        self.assertTrue(p.communicate(timeout=10)[0].startswith(b'GTK:'))
        s = self.server()
        self.assertTrue(s.enable(True)['listening'])
        p = self.run_script()
        s.reply(s.events.wait('askpass_request')['id'], 'ok')
        self.assertEqual(p.communicate(timeout=10)[0], b'ok\n')

    def test_never_execs_itself(self):
        lb = os.path.join(self.fh.home, '.local', 'bin', 'sudo-askpass')
        os.symlink(SCRIPT, lb)
        p = self.run_script(env=self.env(DISPLAY=':99'))
        self.assertEqual(p.communicate(timeout=10)[0], b'')
        self.assertEqual(p.returncode, 1)


class TakeoverTest(Base):
    def answer_from(self, s):
        p = self.run_script()
        s.reply(s.events.wait('askpass_request')['id'], 'pw')
        return p.communicate(timeout=10)[0]

    def test_newest_wins_and_old_takes_back(self):
        a, b = self.server(), self.server()
        a.enable(True)
        b.enable(True)               # a newer app connection
        self.assertEqual(self.answer_from(b), b'pw\n')
        a.check()                    # a notices the path is not its socket any more and the holder is alive
        self.assertIsNone(a.sock)
        a.check()
        self.assertIsNone(a.sock)    # no fight while b is alive
        b.shutdown()                 # b's app disconnected: b removes its own path only
        self.assertFalse(os.path.exists(askpass.sock_path()))
        a.check()
        self.assertIsNotNone(a.sock)
        self.assertEqual(self.answer_from(a), b'pw\n')

    def test_holder_disabled_is_taken_over(self):
        a, b = self.server(), self.server()
        a.enable(True)
        b.enable(True)
        a.check()
        b.enabled = False            # holder answers "unavailable"
        a.check()
        self.assertIsNotNone(a.sock)

    def test_old_exit_does_not_remove_new_socket(self):
        a, b = self.server(), self.server()
        a.enable(True)
        b.enable(True)
        a.shutdown()
        self.assertTrue(os.path.exists(askpass.sock_path()))
        self.assertEqual(self.answer_from(b), b'pw\n')


class AgentEndToEndTest(unittest.TestCase):
    def setUp(self):
        self.fh = fx.FakeHome()
        self.ag = fx.AgentProc(self.fh)
        self.ag.wait_event('projects_changed')

    def tearDown(self):
        self.ag.close()
        fx.kill_tmux_server()
        self.fh.cleanup()

    def script(self, env_extra=None):
        env = dict(self.fh.env(), **(env_extra or {}))
        env.pop('DISPLAY', None)
        return subprocess.Popen([SCRIPT, '[sudo] password:'], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=env)

    def test_prompt_through_agent(self):
        p = self.script()                        # not enabled yet: no socket -> fails (no DISPLAY)
        self.assertEqual(p.communicate(timeout=10)[0], b'')
        r = self.ag.call('askpass_enable', {'enabled': True})
        self.assertTrue(r['result']['listening'], r)
        p = self.script()
        req, since = self.ag.wait_event('askpass_request')
        self.assertEqual(req['prompt'], '[sudo] password:')
        # bad input: rejected without echoing the password
        for bad in ({'id': req['id'], 'password': PASSWORD + '\n'}, {'id': req['id'], 'password': 5},
                    {'id': 'nope', 'password': PASSWORD}, {'id': req['id'], 'password': 'x' * 1025}):
            e = self.ag.call('askpass_reply', bad)['error']
            self.assertEqual(e['code'], 'bad_request')
            self.assertNotIn(PASSWORD, json.dumps(e))
        self.assertIn('result', self.ag.call('askpass_reply', {'id': req['id'], 'password': PASSWORD}))
        out, _ = p.communicate(timeout=10)
        self.assertEqual(out.decode(), PASSWORD + '\n')
        e = self.ag.call('askpass_reply', {'id': req['id'], 'password': PASSWORD})['error']
        self.assertEqual(e['code'], 'not_found')
        self.assertNotIn(PASSWORD, json.dumps(e))
        # agent exit (app gone) while a prompt waits: sudo fails at once, socket removed
        p = self.script()
        self.ag.wait_event('askpass_request', since=since)
        self.ag.close()
        out, _ = p.communicate(timeout=10)
        self.assertEqual((p.returncode, out), (1, b''))
        self.assertFalse(os.path.exists(os.path.join(self.fh.home, '.cache', 'claudespace', 'run', 'askpass.sock')))
        self.assertNotIn(PASSWORD, ''.join(self.ag.stderr))
        self.assertIn('askpass:', ''.join(self.ag.stderr))


if __name__ == '__main__':
    unittest.main()
