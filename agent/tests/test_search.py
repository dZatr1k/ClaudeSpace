"""Full-text search through transcripts (stage 6): what is searched (prompts and answers, not tool output), case and
Cyrillic, JSON escapes, snippets, limits, cancel, and the agent methods/events end to end."""
import json
import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
from cclib import chats, paths, search  # noqa: E402
from tests import fixtures as fx  # noqa: E402


class Collect:
    def __init__(self):
        self.items = []
        self.done = threading.Event()

    def __call__(self, name, data):
        self.items.append((name, data))
        if name == 'search_done':
            self.done.set()

    def hits(self):
        return [h for n, d in self.items if n == 'search_hits' for h in d['hits']]

    def result(self):
        return next(d for n, d in self.items if n == 'search_done')


class UnitTest(unittest.TestCase):
    def test_texts_of(self):
        u = {'type': 'user', 'message': {'role': 'user', 'content': 'найди баг'}}
        self.assertEqual(search.texts_of(u), [('user', 'найди баг')])
        tr = {'type': 'user', 'message': {'content': [{'type': 'tool_result', 'content': 'secret file text'}]}}
        self.assertEqual(search.texts_of(tr), [])
        a = {'type': 'assistant', 'message': {'content': [{'type': 'thinking', 'thinking': 'hmm'},
                                                          {'type': 'tool_use', 'input': {'cmd': 'ls'}},
                                                          {'type': 'text', 'text': 'Готово'}]}}
        self.assertEqual(search.texts_of(a), [('assistant', 'Готово')])
        self.assertEqual(search.texts_of(dict(u, isMeta=True)), [])
        self.assertEqual(search.texts_of(dict(u, isSidechain=True)), [])
        self.assertEqual(search.texts_of({'type': 'summary', 'summary': 'x'}), [])

    def test_snippet(self):
        text = 'a' * 300 + 'NEEDLE' + 'b' * 300
        sn = search.snippet(text, 300, 6)
        s, e = sn['match']
        self.assertEqual(sn['text'][s:e], 'NEEDLE')
        self.assertTrue(sn['text'].startswith('…') and sn['text'].endswith('…'))
        self.assertLessEqual(len(sn['text']), search.SNIPPET + 2)
        sn = search.snippet('строка\nс переводом', 0, 6)
        self.assertEqual(sn['text'], 'строка с переводом')
        self.assertEqual(sn['match'], [0, 6])

    def test_matcher(self):
        m = search.Matcher('Сборк')
        self.assertTrue(m.maybe('почини СБОРКУ'.encode()))
        self.assertFalse(m.maybe('nothing'.encode()))
        m = search.Matcher('say "hi"')
        self.assertTrue(m.maybe(json.dumps({'t': 'I say "HI" there'}).encode()))
        m = search.Matcher('ReadMe')
        self.assertTrue(m.maybe(b'{"text":"see README.md"}'))


class SearchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fh = fx.FakeHome()
        paths.reset(cls.fh.home)
        chats.reset_memory()
        # a chat with a tool result containing the word, and an escaped quote
        p = cls.fh.chat_path(cls.fh.alpha, fx.uuid4())
        sid = os.path.basename(p)[:-6]
        with open(p, 'w') as f:
            f.write(fx.user('посмотри конфиг', '2026-11-07T10:00:00Z', cls.fh.alpha, sid))
            f.write(fx.line(type='user', message={'role': 'user', 'content': [
                {'type': 'tool_result', 'tool_use_id': 'x', 'content': 'zebra-password=123'}]},
                timestamp='2026-11-07T10:00:01Z', cwd=cls.fh.alpha, sessionId=sid))
            f.write(fx.assistant('В конфиге стоит "quoted value" и всё', '2026-11-07T10:00:02Z', cls.fh.alpha, sid))
        cls.tool_chat = sid

    @classmethod
    def tearDownClass(cls):
        paths.reset()
        chats.reset_memory()
        cls.fh.cleanup()

    def run_search(self, q, **kw):
        c = Collect()
        s = search.Searcher(c)
        s.start('t1', q, **kw)
        self.assertTrue(c.done.wait(30))
        return c

    def test_finds_prompts_and_answers_case_insensitive(self):
        c = self.run_search('СБОРК')
        hits = c.hits()
        self.assertEqual([h['chatId'] for h in hits], [fx.ID_AI])
        h = hits[0]
        self.assertEqual(h['title'], 'Починка сборки')
        self.assertEqual(h['project'], self.fh.alpha)
        m = h['matches'][0]
        self.assertEqual(m['role'], 'user')
        self.assertEqual(m['text'][m['match'][0]:m['match'][1]].lower(), 'сборк')
        self.assertIsInstance(m['at'], int)
        r = c.result()
        self.assertEqual((r['found'], r['cancelled'], r['timedOut'], r['truncated']), (1, False, False, False))
        self.assertEqual(r['scanned'], r['total'])

    def test_tool_output_not_searched(self):
        self.assertEqual(self.run_search('zebra-password').hits(), [])

    def test_quotes_and_archive(self):
        hits = self.run_search('"quoted value"').hits()
        self.assertEqual([h['chatId'] for h in hits], [self.tool_chat])
        hits = self.run_search('архивный').hits()
        self.assertEqual([(h['chatId'], h['archived']) for h in hits], [(fx.ID_ARCH, True)])
        self.assertEqual(self.run_search('архивный', archived=False).hits(), [])

    def test_limit_and_per_chat_cap(self):
        c = self.run_search('запрос', limit=1)
        hits = c.hits()
        self.assertEqual(len(hits), 1)
        self.assertLessEqual(len(hits[0]['matches']), search.MAX_PER_CHAT)
        self.assertTrue(c.result()['truncated'])
        big = self.run_search('большой чат: начало').hits()
        self.assertEqual(big[0]['chatId'], fx.ID_BIG)

    def test_cancel_and_supersede(self):
        c = Collect()
        s = search.Searcher(c)
        orig = search.scan_file

        def slow(*a, **kw):
            time.sleep(0.2)
            return orig(*a, **kw)
        search.scan_file = slow
        try:
            s.start('a', 'запрос')
            time.sleep(0.05)
            s.start('b', 'сборк')             # supersedes a
            self.assertTrue(c.done.wait(10))
            deadline = time.time() + 10
            while len([1 for n, _ in c.items if n == 'search_done']) < 2 and time.time() < deadline:
                time.sleep(0.05)
            done = {d['searchId']: d for n, d in c.items if n == 'search_done'}
            self.assertTrue(done['a']['cancelled'])
            self.assertFalse(done['b']['cancelled'])
            self.assertFalse(s.cancel('b'))     # finished
        finally:
            search.scan_file = orig

    def test_budget(self):
        orig = search.scan_file

        def slow(*a, **kw):
            time.sleep(0.6)
            return orig(*a, **kw)
        search.scan_file = slow
        try:
            r = self.run_search('запрос', budget=1.0).result()
        finally:
            search.scan_file = orig
        self.assertTrue(r['timedOut'])
        self.assertLess(r['scanned'], r['total'])


class AgentMethodTest(unittest.TestCase):
    def test_search_methods(self):
        fh = fx.FakeHome()
        ag = fx.AgentProc(fh)
        try:
            ag.wait_event('projects_changed')
            self.assertEqual(ag.call('search_chats', {'searchId': 'x1', 'query': 'a'})['error']['code'],
                             'bad_request')
            self.assertEqual(ag.call('search_chats', {'searchId': '../x', 'query': 'abc'})['error']['code'],
                             'bad_request')
            r = ag.call('search_chats', {'searchId': 'x1', 'query': 'почини'})
            self.assertEqual(r['result'], {'searchId': 'x1'})
            hits, _ = ag.wait_event('search_hits', lambda d: d['searchId'] == 'x1')
            self.assertEqual(hits['hits'][0]['chatId'], fx.ID_AI)
            done, _ = ag.wait_event('search_done', lambda d: d['searchId'] == 'x1')
            self.assertEqual(done['found'], 1)
            self.assertIn('result', ag.call('search_cancel', {}))
        finally:
            ag.close()
            fx.kill_tmux_server()
            fh.cleanup()


if __name__ == '__main__':
    unittest.main()
