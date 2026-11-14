"""Deny-list (DESIGN §7.6): the agent never opens credentials, settings.local.json, history.jsonl,
sessions/*.key or ~/.ssh — checked by an audit hook over a full end-to-end run of every method."""
import ast
import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
from cclib import paths  # noqa: E402
from tests import fixtures as fx  # noqa: E402


class DenyListTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fh = fx.FakeHome()
        paths.reset(cls.fh.home)

    @classmethod
    def tearDownClass(cls):
        fx.kill_tmux_server()
        cls.fh.cleanup()
        paths.reset()

    def test_is_denied(self):
        for p in self.fh.secrets:
            self.assertTrue(paths.is_denied(p), p)
        h = self.fh.home
        self.assertTrue(paths.is_denied(os.path.join(h, '.ssh')))
        self.assertTrue(paths.is_denied(os.path.join(h, '.claude', '.credentials.json.bak')))
        self.assertTrue(paths.is_denied(os.path.join(h, 'projects', '..', '.ssh', 'id_rsa')))
        self.assertFalse(paths.is_denied(os.path.join(h, '.claude', 'sessions', '1.json')))
        self.assertFalse(paths.is_denied(os.path.join(h, '.claude', 'projects', 'x', 'y.jsonl')))
        self.assertFalse(paths.is_denied(os.path.join(h, 'projects', 'history.jsonl')))

    def test_symlink_to_secret_denied(self):
        link = os.path.join(self.fh.home, 'projects', 'innocent.txt')
        os.symlink(os.path.join(self.fh.home, '.ssh', 'id_ed25519'), link)
        try:
            self.assertTrue(paths.is_denied(link))
            with self.assertRaises(paths.DeniedError):
                paths.safe_open(link)
        finally:
            os.unlink(link)

    def test_safe_open_refuses(self):
        for p in self.fh.secrets:
            with self.assertRaises(paths.DeniedError):
                paths.safe_open(p)

    def test_guard_blocks_any_open_in_process(self):
        code = ('import sys; sys.path.insert(0, %r)\n'
                'from cclib import paths; paths.install_guard()\n'
                'try:\n    open(%r).read(); print("READ")\nexcept PermissionError: print("BLOCKED")\n'
                % (fx.AGENT_DIR, self.fh.secrets[0]))
        out = subprocess.run([sys.executable, '-I', '-c', code], capture_output=True, text=True,
                             env=self.fh.env()).stdout
        self.assertEqual(out.strip(), 'BLOCKED')

    def test_no_tg_send_in_cclib(self):
        """ccdata.tg_send reads settings.local.json: it must not be ported."""
        for name in os.listdir(os.path.join(fx.AGENT_DIR, 'cclib')):
            if name.endswith('.py'):
                with open(os.path.join(fx.AGENT_DIR, 'cclib', name), encoding='utf-8') as f:
                    src = f.read()
                tree = ast.parse(src)
                funcs = {n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
                self.assertNotIn('tg_send', funcs, name)
                self.assertNotIn('urllib', src, name)

    def test_no_shell_in_agent(self):
        for root, _, files in os.walk(fx.AGENT_DIR):
            if 'tests' in root:
                continue
            for name in files:
                if name.endswith('.py'):
                    with open(os.path.join(root, name), encoding='utf-8') as f:
                        src = f.read()
                    self.assertNotIn('shell=True', src, name)
                    self.assertNotIn('os.system', src, name)
                    self.assertNotIn('os.popen', src, name)

    def test_end_to_end_never_opens_secrets(self):
        log = os.path.join(self.fh.root, 'audit.log')
        ag = fx.AgentProc(self.fh, audit_log=log)
        try:
            ag.wait_event('projects_changed')
            calls = [('ping', {}), ('list_active', {}), ('list_chats', {}), ('list_chats', {'archived': True}),
                     ('list_projects', {}), ('list_dirs', {}), ('chat_preview', {'chatId': fx.ID_AI}),
                     ('project_preview', {'path': self.fh.alpha}), ('usage', {'maxAge': 0}),
                     ('doctor', {'full': True}), ('doctor', {}), ('system', {'top': True}), ('mosh_list', {}),
                     ('resync', {}), ('rename_chat', {'chatId': fx.ID_AI, 'title': 'x'}),
                     ('rename_chat', {'chatId': fx.ID_AI, 'title': None}),
                     ('project_preview', {'path': os.path.join(self.fh.home, '.ssh')}),
                     ('project_preview', {'path': os.path.join(self.fh.home, '.claude')}),
                     ('new_session', {'cwd': self.fh.alpha, 'name': 'sec'}),
                     ('session_preview', {'session': 'sec'}), ('kill_session', {'session': 'sec'}),
                     ('winfs_status', {}), ('pc_tunnel_status', {}),
                     ('winfs_mount', {'src': 'C:/Data', 'dst': '~/winfs/V'}),
                     ('winfs_mount', {'src': 'C:/Data', 'dst': '~/.ssh/x'}),
                     ('winfs_unmount', {'dst': '~/winfs/V'}), ('list_ports', {}),
                     ('askpass_enable', {'enabled': True}), ('askpass_reply', {'id': '0' * 16, 'password': None}),
                     ('askpass_enable', {'enabled': False}),
                     ('search_chats', {'searchId': 'sec', 'query': 'token', 'budgetSec': 30})]
            for m, p in calls:
                r = ag.call(m, p, timeout=60)
                self.assertNotEqual((r.get('error') or {}).get('code'), 'internal', (m, r))
            ag.wait_event('search_done', lambda d: d['searchId'] == 'sec', timeout=60)
            # .ssh as a project folder is refused (not_allowed) without listing it
            r = ag.call('project_preview', {'path': os.path.join(self.fh.home, '.ssh')})
            self.assertEqual(r['error']['code'], 'not_allowed')
        finally:
            ag.close()
        with open(log, encoding='utf-8') as f:
            opened = f.read().splitlines()
        self.assertTrue(opened, 'audit log is empty: hook did not run')
        bad = []
        for raw in opened:
            p = ast.literal_eval(raw)
            if isinstance(p, bytes):
                p = os.fsdecode(p)
            if paths.is_denied(p):
                bad.append(p)
        self.assertEqual(bad, [], 'agent tried to open denied files')


class ValidationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fh = fx.FakeHome()
        cls.ag = fx.AgentProc(cls.fh)
        cls.ag.wait_event('projects_changed')

    @classmethod
    def tearDownClass(cls):
        cls.ag.close()
        fx.kill_tmux_server()
        cls.fh.cleanup()

    def err(self, method, params):
        r = self.ag.call(method, params)
        self.assertIn('error', r, (method, params, r))
        return r['error']['code']

    def test_chat_id_format(self):
        for bad in ('../../etc/passwd', '11111111-1111-4111-8111-11111111111', 'X' * 36, 42, None):
            self.assertEqual(self.err('chat_preview', {'chatId': bad}), 'bad_request', bad)
        self.assertEqual(self.err('chat_preview', {'chatId': '00000000-0000-4000-8000-000000000000'}), 'not_found')

    def test_paths_outside_home(self):
        link = os.path.join(self.fh.home, 'projects', 'esc')
        os.symlink('/etc', link)
        try:
            for bad in ('/etc', '/', self.fh.home + '/../', link, self.fh.home + '/nope', 'rel\0x'):
                self.assertIn(self.err('new_session', {'cwd': bad}), ('not_allowed', 'bad_request'), bad)
                self.assertIn(self.err('project_preview', {'path': bad}), ('not_allowed', 'bad_request'), bad)
        finally:
            os.unlink(link)
        self.assertEqual(self.err('create_project', {'path': '/tmp/cs-outside'}), 'not_allowed')

    def test_session_names(self):
        for bad in ('a b', 'x;rm -rf ~', 'a:b', 'a.b', '', 'x' * 33, '$(id)'):
            self.assertEqual(self.err('kill_session', {'session': bad}), 'bad_request', bad)
        self.assertEqual(self.err('kill_session', {'session': 'nope'}), 'not_found')

    def test_command_whitelist(self):
        self.assertEqual(self.err('new_session', {'cwd': self.fh.alpha, 'command': 'bash -c id'}), 'bad_request')

    def test_unknown_method_and_bad_frames(self):
        self.assertEqual(self.err('exec', {'cmd': 'id'}), 'bad_request')
        self.assertEqual(self.err('list_chats', {'archived': 'yes'}), 'bad_request')
        self.ag.send_raw(b'not json\n')
        r = self.ag.wait_response(None)
        self.assertEqual(r['error']['code'], 'bad_request')

    def test_too_large(self):
        self.ag.send_raw(b'{"id":1,"method":"ping","params":{"x":"' + b'a' * (4 * 1024 * 1024 + 10) + b'"}}\n')
        r = self.ag.wait_response(None, timeout=30)
        self.assertEqual(r['error']['code'], 'too_large')
        self.assertIn('result', self.ag.call('ping'))      # still alive


if __name__ == '__main__':
    unittest.main()
