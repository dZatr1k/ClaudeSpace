"""Links from chats open on the PC: openurl.py ($BROWSER) <-> unix socket <-> OpenUrlServer <-> the app (event).

Runs the real script against a server in a fake HOME. Covers: a link reaches the app, what is not an http(s) URL is
refused, a burst of links is cut off, the fallback to xdg-open on the VM desktop (with BROWSER removed, so it does not
loop back to us), the peer uid check, chats started with BROWSER, and the agent end to end."""
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
from cclib import appsock, openurl, paths, tmux  # noqa: E402
from tests import fixtures as fx  # noqa: E402
from tests.test_askpass import Events  # noqa: E402

SCRIPT = os.path.join(fx.AGENT_DIR, 'openurl.py')
URL = 'https://example.com/jobs/7539589e?ref=chat&x=%D1%8F'


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
        s = openurl.OpenUrlServer(ev, **kw)
        s.events = ev
        self.servers.append(s)
        return s

    def env(self, **extra):
        e = self.fh.env()
        e.pop('DISPLAY', None)
        e.pop('WAYLAND_DISPLAY', None)
        e.update(extra)
        return e

    def run_script(self, *args, env=None):
        p = subprocess.run([SCRIPT, *args], capture_output=True, env=env or self.env(BROWSER=SCRIPT), timeout=10)
        return p.returncode, p.stdout.decode(), p.stderr.decode()

    def fake_xdg_open(self):
        """xdg-open on PATH that records its argument and whether BROWSER reached it."""
        d = os.path.join(self.fh.home, 'bin')
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, 'xdg-open')
        with open(p, 'w') as f:
            f.write('#!/bin/sh\necho "xdg-open:$1 BROWSER=${BROWSER-unset}"\n')
        os.chmod(p, 0o755)
        return d


class ScriptTest(Base):
    def test_link_reaches_the_app(self):
        s = self.server()
        s.enable(True)
        self.assertEqual(self.run_script(URL)[0], 0)
        self.assertEqual(s.events.wait('open_url'), {'url': URL})

    def test_not_a_web_link_is_refused(self):
        s = self.server()
        s.enable(True)
        for bad in ('file:///etc/passwd', 'javascript:alert(1)', 'https://', 'example.com',
                    'https://a.example/ b', 'https://a.example/\x1b[2J', 'http://x/' + 'a' * openurl.MAX_URL):
            code, _, err = self.run_script(bad)
            self.assertEqual(code, 1, bad)
            self.assertIn('bad', err)
        with self.assertRaises(TimeoutError):
            s.events.wait('open_url', timeout=0.3)

    def test_burst_is_cut_off(self):
        now = [100.0]
        s = self.server(clock=lambda: now[0])
        s.enable(True)
        codes = [self.run_script(f'https://example.com/{i}')[0] for i in range(openurl.BURST + 1)]
        self.assertEqual(codes, [0] * openurl.BURST + [1])
        now[0] += openurl.WINDOW
        self.assertEqual(self.run_script(URL)[0], 0)

    def test_no_url_is_a_usage_error(self):
        self.assertEqual(self.run_script()[0], 2)

    def test_peer_uid_checked(self):
        s = self.server()
        s.enable(True)
        real = appsock.peer_cred
        with mock.patch.object(appsock, 'peer_cred', lambda c: (lambda p, u, g: (p, u + 1, g))(*real(c))):
            code, _, _ = self.run_script(URL)
        self.assertEqual(code, 1)        # the connection is dropped without an answer, no desktop to fall back to
        with self.assertRaises(TimeoutError):
            s.events.wait('open_url', timeout=0.3)

    def test_socket_is_private(self):
        s = self.server()
        s.enable(True)
        self.assertEqual(os.stat(s.path).st_mode & 0o777, 0o600)
        self.assertEqual(os.path.basename(s.path), 'openurl.sock')
        self.assertEqual(os.stat(appsock.run_dir()).st_mode & 0o777, 0o700)


class FallbackTest(Base):
    def test_no_app_no_desktop_fails(self):
        code, out, err = self.run_script(URL)
        self.assertEqual((code, out), (1, ''))
        self.assertIn('ClaudeSpace', err)

    def test_no_app_uses_the_vm_browser_without_looping_back(self):
        d = self.fake_xdg_open()
        env = self.env(DISPLAY=':99', BROWSER=SCRIPT, PATH=d + os.pathsep + os.environ['PATH'])
        code, out, _ = self.run_script(URL, env=env)
        self.assertEqual((code, out), (0, f'xdg-open:{URL} BROWSER=unset\n'))

    def test_app_gone_falls_back(self):
        s = self.server()
        s.enable(True)
        s.enabled = False                # the socket is still there, but its agent no longer answers
        d = self.fake_xdg_open()
        env = self.env(DISPLAY=':99', PATH=d + os.pathsep + os.environ['PATH'])
        self.assertTrue(self.run_script(URL, env=env)[1].startswith('xdg-open:'))

    def test_stale_socket_falls_back(self):
        appsock.ensure_private_dir(appsock.run_dir())
        dead = socket.socket(socket.AF_UNIX)
        dead.bind(os.path.join(appsock.run_dir(), 'openurl.sock'))
        dead.close()                     # a socket file nobody listens on: an agent that was killed
        self.assertEqual(self.run_script(URL)[0], 1)


class ChatCommandTest(unittest.TestCase):
    def test_chats_get_browser_when_the_script_is_installed(self):
        cmd = tmux.claude_command('abc')
        self.assertIn(f'export BROWSER={SCRIPT};', cmd)
        self.assertLess(cmd.index('BROWSER'), cmd.index('claude --resume'))

    def test_no_browser_without_the_script(self):
        fake = os.path.join(tempfile.gettempdir(), 'cs-no-agent', 'cclib', 'openurl.py')
        with mock.patch.object(openurl, '__file__', fake):
            self.assertIsNone(openurl.script_path())
            self.assertNotIn('BROWSER', tmux.claude_command())


class AgentEndToEndTest(unittest.TestCase):
    def setUp(self):
        self.fh = fx.FakeHome()
        self.ag = fx.AgentProc(self.fh)
        self.ag.wait_event('projects_changed')

    def tearDown(self):
        self.ag.close()
        fx.kill_tmux_server()
        self.fh.cleanup()

    def test_link_through_agent(self):
        env = self.fh.env()
        env.pop('DISPLAY', None)
        p = subprocess.run([SCRIPT, URL], capture_output=True, env=env, timeout=10)
        self.assertEqual(p.returncode, 0, p.stderr)
        data, _ = self.ag.wait_event('open_url')
        self.assertEqual(data, {'url': URL})
        self.assertIn('openurl: sent a link', ''.join(self.ag.stderr))
        self.assertNotIn('example.com', ''.join(self.ag.stderr))      # links may carry tokens: never logged
