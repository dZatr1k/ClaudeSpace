"""Several apps on one VM (PC, phone, a dev copy): a sudo prompt or a link goes to the app whose terminal it came
from (cclib/route.py, the redirect in cclib/appsock.py, the scripts askpass.py and openurl.py).

Covers: the pure decision; the redirect between two servers with the real scripts (the target answers, a terminal of
no app gets "unavailable", a target that is gone or turned off); real tmux clients attached through a pty with
CLAUDESPACE_APP, where the client the user last typed in wins; two agent processes end to end."""
import os
import select
import subprocess
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
from cclib import appsock, askpass, openurl, paths, route  # noqa: E402
from tests import fixtures as fx  # noqa: E402
from tests.test_askpass import Events  # noqa: E402

A, B = 'a' * 16, 'b' * 16
URL = 'https://example.com/route?x=1'
OPENURL = os.path.join(fx.AGENT_DIR, 'openurl.py')
ASKPASS = os.path.join(fx.AGENT_DIR, 'askpass.py')


class DecideTest(unittest.TestCase):
    def test_the_last_client_of_the_pane_session_decides(self):
        clients = [(100, 'chat', A), (105, 'chat', B), (200, 'other', A)]
        self.assertEqual(route.decide(None, clients, 'chat'), ('app', B))

    def test_a_client_of_no_app_means_no_app(self):
        clients = [(100, 'chat', A), (105, 'chat', None)]
        self.assertEqual(route.decide(A, clients, 'chat'), ('none', None))

    def test_outside_tmux_the_script_own_app(self):
        self.assertEqual(route.decide(B, [(300, 'chat', A)], None), ('app', B))

    def test_nobody_watching_the_app_touched_last(self):
        clients = [(100, 'x', A), (150, 'y', B), (400, 'z', None)]
        self.assertEqual(route.decide(None, clients, 'background'), ('app', B))
        self.assertEqual(route.decide(None, clients, None), ('app', B))

    def test_nothing_to_go_by(self):
        self.assertEqual(route.decide(None, [], None), ('any', None))
        self.assertEqual(route.decide(None, [(1, 'x', None)], 'chat'), ('any', None))


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

    def env(self, **extra):
        e = self.fh.env()
        e.pop('DISPLAY', None)
        e.pop('WAYLAND_DISPLAY', None)
        e.update(extra)
        return e

    def openurl_server(self, app_id, router=None, enable=True):
        ev = Events()
        s = openurl.OpenUrlServer(ev, app_id=app_id, router=router)
        s.events = ev
        self.servers.append(s)
        if enable:
            s.enable(True)
        else:
            s.check()
        return s

    def open_link(self, **env):
        p = subprocess.run([OPENURL, URL], capture_output=True, env=self.env(**env), timeout=10)
        return p.returncode


class RedirectTest(Base):
    def test_the_link_goes_to_the_app_the_router_names(self):
        b = self.openurl_server(B)
        a = self.openurl_server(A, router=lambda msg: ('app', B))      # newest: holds openurl.sock
        self.assertEqual(self.open_link(), 0)
        self.assertEqual(b.events.wait('open_url'), {'url': URL})
        with self.assertRaises(TimeoutError):
            a.events.wait('open_url', timeout=0.3)

    def test_own_app_answers_itself(self):
        a = self.openurl_server(A, router=lambda msg: ('app', A))
        self.assertEqual(self.open_link(), 0)
        self.assertEqual(a.events.wait('open_url'), {'url': URL})

    def test_the_router_sees_the_script_environment(self):
        seen = []
        self.openurl_server(A, router=lambda msg: seen.append(msg) or ('any', None))
        self.assertEqual(self.open_link(TMUX='/tmp/x,1,0', TMUX_PANE='%3', CLAUDESPACE_APP=B), 0)
        self.assertEqual({k: seen[0][k] for k in ('tmux', 'pane', 'app')},
                         {'tmux': '/tmp/x,1,0', 'pane': '%3', 'app': B})

    def test_a_terminal_of_no_app_gets_nothing(self):
        a = self.openurl_server(A, router=lambda msg: ('none', None))
        self.assertEqual(self.open_link(), 1)        # no desktop here: Claude Code says it could not open it
        with self.assertRaises(TimeoutError):
            a.events.wait('open_url', timeout=0.3)

    def test_target_gone_the_holder_answers(self):
        b = self.openurl_server(B)
        a = self.openurl_server(A, router=lambda msg: ('app', B))
        own = b.own[0]
        own.close()                     # B's agent was killed: its socket file is left, nobody listens
        self.assertTrue(os.path.exists(b.own_path()))
        self.assertEqual(self.open_link(), 0)
        self.assertEqual(a.events.wait('open_url'), {'url': URL})

    def test_target_without_a_socket_the_holder_answers(self):
        a = self.openurl_server(A, router=lambda msg: ('app', B))     # no agent of B at all
        self.assertEqual(self.open_link(), 0)
        self.assertEqual(a.events.wait('open_url'), {'url': URL})

    def test_target_turned_off_falls_back(self):
        b = self.openurl_server(B, enable=False)     # its socket is there, it does not take links
        self.assertTrue(os.path.exists(b.own_path()))
        a = self.openurl_server(A, router=lambda msg: ('app', B))
        self.assertEqual(self.open_link(), 1)
        for s in (a, b):
            with self.assertRaises(TimeoutError):
                s.events.wait('open_url', timeout=0.2)

    def test_app_socket_is_private_and_removed_on_exit(self):
        b = self.openurl_server(B)
        path = b.own_path()
        self.assertEqual(os.path.basename(path), f'openurl.{B}.sock')
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        b.shutdown()
        self.assertFalse(os.path.exists(path))

    def test_no_app_id_no_app_socket(self):
        s = self.openurl_server(None)
        self.assertIsNone(s.own)
        self.assertEqual(sorted(os.listdir(appsock.run_dir())), ['openurl.sock'])

    def test_sudo_prompt_goes_to_its_app(self):
        evb, eva = Events(), Events()
        b = askpass.AskpassServer(evb, app_id=B)
        a = askpass.AskpassServer(eva, app_id=A, router=lambda msg: ('app', B))
        self.servers += [b, a]
        b.enable(True)
        a.enable(True)
        p = subprocess.Popen([ASKPASS, 'pw:'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.env())
        req = evb.wait('askpass_request')
        self.assertTrue(b.reply(req['id'], 'secret'))
        out, err = p.communicate(timeout=10)
        self.assertEqual((p.returncode, out), (0, b'secret\n'), err)
        with self.assertRaises(TimeoutError):
            eva.wait('askpass_request', timeout=0.2)


class Client:
    """`tmux attach` in a pty, as an app's terminal tab runs it (with CLAUDESPACE_APP) or `cc` does (without)."""

    def __init__(self, fh, session, app):
        master, slave = os.openpty()
        env = dict(fh.env(), TERM='xterm-256color')
        if app:
            env['CLAUDESPACE_APP'] = app
        self.p = subprocess.Popen(['tmux', '-L', fx.TMUX_SOCKET, 'attach', '-t', session], stdin=slave,
                                  stdout=slave, stderr=slave, env=env, start_new_session=True)
        os.close(slave)
        self.master = master
        self.t = threading.Thread(target=self._drain, daemon=True)
        self.t.start()

    def _drain(self):
        while True:
            try:
                r, _, _ = select.select([self.master], [], [], 0.5)
                if r and not os.read(self.master, 65536):
                    return
            except OSError:
                return
            if self.p.poll() is not None:
                return

    def type(self, data=b'x'):
        os.write(self.master, data)

    def close(self):
        self.p.kill()
        self.p.wait(5)
        try:
            os.close(self.master)
        except OSError:
            pass


class TmuxTest(Base):
    def setUp(self):
        super().setUp()
        fx.kill_tmux_server()
        for name in ('chat', 'other'):
            fx.tmux('new-session', '-d', '-s', name, '-x', '80', '-y', '24', 'sleep 600', env=self.fh.env())
        self.sock = fx.tmux('display-message', '-p', '#{socket_path}', env=self.fh.env()).stdout.strip()
        self.pane = fx.tmux('display-message', '-p', '-t', 'chat', '#{pane_id}', env=self.fh.env()).stdout.strip()
        self.clients = []

    def tearDown(self):
        for c in self.clients:
            c.close()
        fx.kill_tmux_server()
        super().tearDown()

    def attach(self, session, app):
        c = Client(self.fh, session, app)
        self.clients.append(c)
        return c

    def wait_clients(self, n):
        end = time.time() + 10
        while time.time() < end:
            out = fx.tmux('list-clients', '-F', '#{client_pid}', env=self.fh.env()).stdout.split()
            if len(out) >= n:
                return
            time.sleep(0.1)
        self.fail(f'{n} tmux clients did not attach')

    def route(self, **msg):
        return route.Router()(dict({'tmux': f'{self.sock},1,0', 'pane': self.pane}, **msg))

    def test_the_client_the_user_typed_in_wins(self):
        a = self.attach('chat', A)
        b = self.attach('chat', B)
        self.wait_clients(2)
        time.sleep(1.1)                 # client_activity counts whole seconds
        b.type()
        time.sleep(0.3)
        self.assertEqual(self.route(), ('app', B))
        time.sleep(1.1)
        a.type()
        time.sleep(0.3)
        self.assertEqual(self.route(), ('app', A))

    def test_a_cc_client_takes_the_request_away_from_apps(self):
        self.attach('chat', A)
        cc = self.attach('chat', None)
        self.wait_clients(2)
        time.sleep(1.1)
        cc.type()
        time.sleep(0.3)
        self.assertEqual(self.route(), ('none', None))

    def test_background_chat_goes_to_the_app_touched_last(self):
        self.attach('other', A)
        self.wait_clients(1)
        self.assertEqual(self.route(), ('app', A))     # nobody watches "chat"

    def test_plain_shell_and_bad_input(self):
        self.assertEqual(route.Router()({'app': B}), ('app', B))
        self.assertEqual(route.Router()({'app': 'not-an-id'}), ('any', None))
        # a $TMUX that is not a socket of ours is ignored, and so is its pane
        self.assertEqual(self.route(tmux='/etc/passwd,1,0'), ('any', None))
        self.assertEqual(self.route(pane='%1; rm -rf ~'), ('any', None))


class TwoAgentsTest(unittest.TestCase):
    """Two agents of two apps on one HOME; the link from a pane goes to the app whose client watches it."""

    def setUp(self):
        self.fh = fx.FakeHome()
        fx.kill_tmux_server()
        fx.tmux('new-session', '-d', '-s', 'chat', '-x', '80', '-y', '24', 'sleep 600', env=self.fh.env())
        self.agents = []
        for app in (B, A):              # A starts last and holds openurl.sock
            ag = fx.AgentProc(self.fh, args=['--app', app])
            ag.wait_event('projects_changed')
            self.agents.append(ag)
        self.client = Client(self.fh, 'chat', B)

    def tearDown(self):
        self.client.close()
        for ag in self.agents:
            ag.close()
        fx.kill_tmux_server()
        self.fh.cleanup()

    def test_link_reaches_the_watching_app(self):
        run = os.path.join(self.fh.home, '.cache', 'claudespace', 'run')
        self.assertTrue(os.path.exists(os.path.join(run, f'openurl.{A}.sock')))
        self.assertTrue(os.path.exists(os.path.join(run, f'openurl.{B}.sock')))
        sock = fx.tmux('display-message', '-p', '#{socket_path}', env=self.fh.env()).stdout.strip()
        pane = fx.tmux('display-message', '-p', '-t', 'chat', '#{pane_id}', env=self.fh.env()).stdout.strip()
        end = time.time() + 10
        while not fx.tmux('list-clients', env=self.fh.env()).stdout.strip() and time.time() < end:
            time.sleep(0.1)
        env = dict(self.fh.env(), TMUX=f'{sock},1,0', TMUX_PANE=pane)
        env.pop('DISPLAY', None)
        p = subprocess.run([OPENURL, URL], capture_output=True, env=env, timeout=10)
        self.assertEqual(p.returncode, 0, p.stderr)
        agent_b, agent_a = self.agents
        data, _ = agent_b.wait_event('open_url')
        self.assertEqual(data, {'url': URL})
        with self.assertRaises(TimeoutError):
            agent_a.wait_event('open_url', timeout=0.5)


if __name__ == '__main__':
    unittest.main()
