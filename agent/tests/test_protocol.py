"""csagent end-to-end over stdin/stdout with a real tmux on a dedicated socket (tmux -L claudespace-test-py-*)."""
import json
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
from tests import fixtures as fx  # noqa: E402


class ProtocolTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fh = fx.FakeHome()
        fx.kill_tmux_server()
        cls.ag = fx.AgentProc(cls.fh)
        cls.hello, _ = cls.ag.wait_event('hello')
        cls.ag.wait_event('projects_changed')

    @classmethod
    def tearDownClass(cls):
        rc = cls.ag.close()
        fx.kill_tmux_server()
        cls.fh.cleanup()
        assert rc == 0, f'agent exit code {rc}'

    def ok(self, method, params=None, timeout=15):
        r = self.ag.call(method, params, timeout)
        self.assertIn('result', r, (method, params, r))
        return r['result']

    def screen(self, name, want='fake claude', timeout=5):
        deadline, text = time.time() + timeout, ''
        while time.time() < deadline and want not in text:
            text = fx.tmux('capture-pane', '-p', '-t', f'={name}:').stdout
            time.sleep(0.2)
        return text

    def test_hello(self):
        h = self.hello
        self.assertEqual(h['protocol'], 1)
        self.assertEqual(h['home'], self.fh.home)
        self.assertTrue(h['hash'].startswith('sha256:'))
        self.assertEqual(h['claudeVersion'], 'claude-1.0.0')
        self.assertIn('git', h['capabilities'])
        self.assertEqual(h['warnings'], [])

    def test_initial_snapshots(self):
        d, _ = self.ag.wait_event('chats_changed', lambda d: 'full' in d)
        ids = {c['id'] for c in d['full']}
        self.assertIn(fx.ID_AI, ids)
        self.assertIn(fx.ID_ARCH, ids)              # archived chats come with the full snapshot (archived: true)
        self.assertNotIn(fx.ID_EMPTY, ids)
        p, _ = self.ag.wait_event('projects_changed')
        self.assertIn(self.fh.alpha, [x['path'] for x in p['full']])
        self.ag.wait_event('system', timeout=5)
        dw, _ = self.ag.wait_event('doctor_warning', timeout=30)
        self.assertIn(dw['level'], ('ok', 'warn', 'error'))

    def test_list_methods(self):
        self.assertIsInstance(self.ok('ping')['now'], int)
        chats = self.ok('list_chats')['chats']
        self.assertEqual(chats[0]['lastAt'], max(c['lastAt'] for c in chats))
        self.assertTrue(all(not c['archived'] for c in chats))
        self.assertEqual([c['id'] for c in self.ok('list_chats', {'archived': True})['chats']], [fx.ID_ARCH])
        self.assertEqual(len(self.ok('list_chats', {'limit': 2})['chats']), 2)
        self.assertIn(self.fh.alpha, self.ok('list_dirs')['dirs'])
        pr = self.ok('project_preview', {'path': self.fh.alpha})
        self.assertTrue(pr['hasClaudeMd'])
        self.assertEqual(pr['git']['branch'], 'main')
        self.assertIn('CLAUDE.md', pr['entries'])
        cp = self.ok('chat_preview', {'chatId': fx.ID_AI, 'messages': 1})
        self.assertEqual(cp['chat']['title'], 'Починка сборки')
        self.assertEqual(len(cp['tail']), 1)
        st = self.ok('system', {'top': True})
        self.assertIn('memPct', st)
        self.assertTrue(st['top'])
        d = self.ok('doctor', {'full': True}, timeout=60)
        self.assertIn(d['level'], ('ok', 'warn', 'error'))
        self.assertTrue(any(t['name'] == 'claude --resume' and t['ok'] for t in d['tools']))
        u = self.ok('usage', {'maxAge': 0}, timeout=60)
        self.assertIn('ok', u)

    def test_sessions_lifecycle(self):
        r = self.ok('new_session', {'cwd': self.fh.alpha})
        name = r['session']
        self.assertEqual(name, 'Alpha')
        d, _ = self.ag.wait_event('active_changed', lambda d: any(s['name'] == name for s in d['sessions']))
        # second session in the same folder gets a suffix
        self.assertEqual(self.ok('new_session', {'cwd': self.fh.alpha})['session'], 'Alpha-2')
        # the fake claude runs inside
        self.assertIn('fake claude', self.screen(name))
        # session_preview without Claude: session, uptime, no clients, git of the folder
        sp = self.ok('session_preview', {'session': name})
        self.assertEqual((sp['session']['name'], sp['session']['path']), (name, self.fh.alpha))
        self.assertLessEqual(abs(sp['created'] - time.time() * 1000), 10000)
        self.assertEqual(sp['clients'], [])
        self.assertEqual(sp['git']['branch'], 'main')
        self.assertEqual(sp['claude'], [])
        self.assertNotIn('text', sp)
        self.assertEqual(self.ag.call('session_preview', {'session': 'nope'})['error']['code'], 'not_found')
        # a Claude process registered for a pane of this session -> status + events within 2 s
        pane = fx.tmux('list-panes', '-t', f'={name}', '-F', '#{pane_id} #{pane_pid}').stdout.split()
        pane_id, pane_pid = pane[0], int(pane[1])
        reg = self.fh.register(pane_pid, fx.ID_CUSTOM, 'busy', f'{name}:@1.{pane_id}')
        t0 = time.time()
        _, i = self.ag.wait_event('session_status', lambda d: d['chatId'] == fx.ID_CUSTOM and d['status'] == 'busy',
                                  timeout=4)
        self.fh.register(pane_pid, fx.ID_CUSTOM, 'waiting', f'{name}:@1.{pane_id}')
        t1 = time.time()
        d, _ = self.ag.wait_event('session_status', lambda d: d['chatId'] == fx.ID_CUSTOM and d['status'] == 'waiting',
                                  timeout=4, since=i)
        self.assertLess(time.time() - t1, 2.5)
        self.assertEqual((d['prev'], d['session']), ('busy', name))
        self.assertLess(t1 - t0, 4)
        # session_preview with Claude: chat title as in the list, last prompt, model and context tokens
        with open(self.fh.chat_path(self.fh.alpha, fx.ID_CUSTOM), 'a') as f:
            f.write(fx.user('второй запрос', '2026-11-08T12:00:00Z', self.fh.alpha, fx.ID_CUSTOM))
            f.write(fx.line(type='assistant', timestamp='2026-11-08T12:00:09Z', sessionId=fx.ID_CUSTOM, message={
                'role': 'assistant', 'model': 'claude-opus-4-5', 'content': [{'type': 'text', 'text': 'ok'}],
                'usage': {'input_tokens': 5, 'cache_read_input_tokens': 1000, 'output_tokens': 7}}))
        sp = self.ok('session_preview', {'session': name})
        self.assertEqual(sp['session']['claude'][0]['status'], 'waiting')
        cl = sp['claude'][0]
        self.assertEqual((cl['chatId'], cl['chat']['title'], cl['chat']['open']['session']),
                         (fx.ID_CUSTOM, 'Моё название', name))
        self.assertEqual(cl['lastPrompt'], {'text': 'второй запрос', 'at': 1794139200000})
        self.assertEqual((cl['model'], cl['context']), ('claude-opus-4-5', {'tokens': 1005, 'output': 7}))
        act = self.ok('list_active')['sessions']
        s = next(s for s in act if s['name'] == name)
        self.assertEqual(s['claude'][0]['chatId'], fx.ID_CUSTOM)
        self.assertEqual(s['claude'][0]['pane'], pane_id)
        # quick actions go to that pane (the tty echoes them: the fake claude is just `sleep`); commands only when
        # idle (Enter at a permission prompt would approve it), Esc any time
        self.assertEqual(self.ag.call('claude_send', {'chatId': fx.ID_CUSTOM, 'action': 'compact'})['error']['code'],
                         'busy')
        self.ok('claude_send', {'chatId': fx.ID_CUSTOM, 'action': 'interrupt'})
        self.fh.register(pane_pid, fx.ID_CUSTOM, 'idle', f'{name}:@1.{pane_id}')
        self.assertEqual(self.ok('claude_send', {'chatId': fx.ID_CUSTOM, 'action': 'compact'})['pane'], pane_id)
        self.assertIn('/compact', self.screen(name, '/compact'))
        self.ok('claude_send', {'chatId': fx.ID_CUSTOM, 'action': 'model', 'model': 'sonnet'})
        self.assertIn('/model sonnet', self.screen(name, '/model sonnet'))
        for bad in ({'chatId': fx.ID_CUSTOM, 'action': 'model', 'model': 'x; rm'},
                    {'chatId': fx.ID_CUSTOM, 'action': 'say', 'text': 'hi'},
                    {'chatId': fx.ID_CUSTOM, 'action': 'model'}):
            self.assertEqual(self.ag.call('claude_send', bad)['error']['code'], 'bad_request', bad)
        self.assertEqual(self.ag.call('claude_send', {'chatId': fx.ID_ARCH, 'action': 'clear'})['error']['code'],
                         'not_found')
        self.fh.register(pane_pid, fx.ID_CUSTOM, 'waiting', f'{name}:@1.{pane_id}')   # back, for the checks below
        # chat is now "open" -> chats_changed upsert with open.session
        self.ag.wait_event('chats_changed', lambda d: any(c['id'] == fx.ID_CUSTOM and (c.get('open') or {}).get(
            'session') == name for c in d.get('upsert', []) + d.get('full', [])), timeout=5)
        # project shows the live session
        self.ag.wait_event('projects_changed', lambda d: any(
            p['path'] == self.fh.alpha and p['liveSession'] == name and p['liveStatus'] == 'waiting'
            for p in d['full']), timeout=5)
        # resume of an open chat is refused (no second `claude --resume`), archiving too
        r = self.ag.call('new_session', {'cwd': self.fh.alpha, 'resume': fx.ID_CUSTOM})
        self.assertEqual(r['error']['code'], 'chat_open')
        self.assertEqual(r['error']['data']['session'], name)
        self.assertEqual(self.ag.call('archive_chat', {'chatId': fx.ID_CUSTOM})['error']['code'], 'chat_open')
        self.ok('focus_window', {'session': name, 'window': d.get('window') or '0'})
        # rename + kill
        self.assertEqual(self.ok('rename_session', {'session': 'Alpha-2', 'name': 'my game!'})['session'], 'my_game_')
        self.assertEqual(self.ag.call('rename_session', {'session': 'my_game_', 'name': name})['error']['code'],
                         'exists')
        self.ok('kill_session', {'session': 'my_game_'})
        self.ag.wait_event('active_changed', lambda d: not any(s['name'] == 'my_game_' for s in d['sessions']))
        os.unlink(reg)
        self.ok('kill_session', {'session': name})
        self.ag.wait_event('active_changed', lambda d: not any(s['name'] == name for s in d['sessions']))

    def test_resume_command_quoted(self):
        r = self.ok('new_session', {'cwd': self.fh.beta, 'resume': fx.ID_SUMMARY, 'name': 'resume-test'})
        self.assertEqual(r['session'], 'resume-test')
        self.assertIn(f'fake claude --resume {fx.ID_SUMMARY}', self.screen('resume-test'))
        self.ok('kill_session', {'session': 'resume-test'})

    def test_archive_restore_rename_events(self):
        r = self.ok('archive_chat', {'chatId': fx.ID_SUMMARY})
        self.assertTrue(r['chat']['archived'])
        self.ag.wait_event('chats_changed', lambda d: any(c['id'] == fx.ID_SUMMARY and c['archived']
                                                         for c in d.get('upsert', [])), timeout=6)
        self.assertFalse(self.ok('restore_chat', {'chatId': fx.ID_SUMMARY})['chat']['archived'])
        r = self.ok('rename_chat', {'chatId': fx.ID_SUMMARY, 'title': '  Новое   имя '})
        self.assertEqual((r['chat']['title'], r['chat']['titleSource']), ('Новое имя', 'alias'))
        self.ag.wait_event('chats_changed', lambda d: any(c['id'] == fx.ID_SUMMARY and c['title'] == 'Новое имя'
                                                         for c in d.get('upsert', [])), timeout=6)
        self.assertEqual(self.ok('rename_chat', {'chatId': fx.ID_SUMMARY, 'title': None})['chat']['titleSource'],
                         'summary')

    def test_new_chat_file_appears(self):
        sid = fx.uuid4()
        with open(self.fh.chat_path(self.fh.beta, sid), 'w') as f:
            f.write(fx.user('новый чат из cc', '2026-11-07T10:00:00Z', self.fh.beta, sid))
        t0 = time.time()
        self.ag.wait_event('chats_changed', lambda d: any(c['id'] == sid for c in d.get('upsert', [])), timeout=6)
        self.assertLess(time.time() - t0, 5)

    def test_turn_done_from_hook_file(self):
        d = os.path.join(self.fh.home, '.cache', 'claudespace')
        os.makedirs(d, exist_ok=True)
        ev = {'ts': int(time.time() * 1000) + 5, 'kind': 'done', 'sessionId': 'chat-x', 'cwd': self.fh.alpha,
              'project': 'Alpha', 'body': '✅ Тесты прошли'}
        with open(os.path.join(d, 'events.jsonl'), 'a') as f:
            f.write(json.dumps(ev, ensure_ascii=False) + '\n')
        data, _ = self.ag.wait_event('turn_done', lambda x: x.get('chatId') == 'chat-x', timeout=5)
        self.assertEqual(data['body'], 'Тесты прошли')
        self.assertEqual(data['kind'], 'done')
        self.assertIn('session', data)

    def test_create_project(self):
        p = os.path.join(self.fh.home, 'projects', 'Delta')
        r = self.ok('create_project', {'path': p, 'gitInit': True})
        self.assertEqual(r['project']['path'], p)
        self.assertEqual(self.ag.call('create_project', {'path': p})['error']['code'], 'exists')
        self.ag.wait_event('projects_changed', lambda d: any(x['path'] == p for x in d['full']), timeout=40)
        # right in ~, no chat yet: still shows up in the project list
        q = os.path.join(self.fh.home, 'Eta')
        r = self.ok('create_project', {'path': '~/Eta'})
        self.assertEqual((r['project']['path'], r['project']['name']), (q, 'home/Eta'))
        self.ag.wait_event('projects_changed', lambda d: any(x['path'] == q for x in d['full']), timeout=40)

    def test_resync(self):
        n = len(self.ag.events)
        self.ok('resync')
        self.ag.wait_event('chats_changed', lambda d: 'full' in d, since=n, timeout=5)
        self.ag.wait_event('projects_changed', since=n, timeout=5)
        self.ag.wait_event('active_changed', since=n, timeout=5)

    def test_frames_are_single_lines_utf8(self):
        raw = json.dumps({'id': 'x', 'method': 'ping'}).encode() + b'\n'
        self.ag.send_raw(raw)
        self.assertIn('result', self.ag.wait_response('x'))


class EofTest(unittest.TestCase):
    def test_exits_on_eof(self):
        fh = fx.FakeHome()
        try:
            ag = fx.AgentProc(fh)
            ag.wait_event('hello')
            t0 = time.time()
            self.assertEqual(ag.close(), 0)
            self.assertLess(time.time() - t0, 15)
        finally:
            fx.kill_tmux_server()
            fh.cleanup()


if __name__ == '__main__':
    unittest.main()
