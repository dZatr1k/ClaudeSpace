"""cclib.turns: tail of the hook's events.jsonl — only new events, partial lines, trim/replace, junk."""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
from cclib import paths, turns  # noqa: E402


def line(kind='done', sid='s1', body='✅ Готово', ts=None):
    return json.dumps({'ts': ts or int(time.time() * 1000) + 1, 'kind': kind, 'sessionId': sid,
                       'cwd': '/p', 'project': 'p', 'body': body}, ensure_ascii=False) + '\n'


class TurnsTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix='cs-turns-')
        for k in ('XDG_CACHE_HOME', 'XDG_STATE_HOME'):
            os.environ.pop(k, None)
        paths.reset(self.home)
        os.makedirs(paths.P.cache)
        self.f = turns.events_path()

    def tearDown(self):
        paths.reset()
        shutil.rmtree(self.home, ignore_errors=True)

    def append(self, s):
        with open(self.f, 'a') as fh:
            fh.write(s)

    def test_only_events_after_start_and_body_cleaned(self):
        self.append(line(ts=1000))  # history: never replayed
        t = turns.TurnTail()
        t.start()
        self.assertEqual(t.read_new(), [])
        self.append(line(kind='input', sid='abc', body='⏳ Нужно разрешение'))
        evs = t.read_new()
        self.assertEqual(len(evs), 1)
        self.assertEqual(evs[0]['kind'], 'input')
        self.assertEqual(evs[0]['chatId'], 'abc')
        self.assertEqual(evs[0]['body'], 'Нужно разрешение')
        self.assertEqual(t.read_new(), [])

    def test_missing_file_then_created(self):
        t = turns.TurnTail()
        t.start()
        self.assertEqual(t.read_new(), [])
        self.append(line())
        self.assertEqual(len(t.read_new()), 1)

    def test_partial_line_waits(self):
        t = turns.TurnTail()
        t.start()
        full = line()
        self.append(full[:20])
        self.assertEqual(t.read_new(), [])
        self.append(full[20:])
        self.assertEqual(len(t.read_new()), 1)

    def test_trimmed_file_does_not_replay(self):
        t = turns.TurnTail()
        t.start()
        a, b = line(body='a'), line(body='b', ts=int(time.time() * 1000) + 50)
        self.append(a)
        self.assertEqual([e['body'] for e in t.read_new()], ['a'])
        # the hook's trim: tail + mv → new inode, smaller file that still holds "a"
        tmp = self.f + '.tmp'
        with open(tmp, 'w') as fh:
            fh.write(a + b)
        os.replace(tmp, self.f)
        self.assertEqual([e['body'] for e in t.read_new()], ['b'])

    def test_junk_is_ignored(self):
        t = turns.TurnTail()
        t.start()
        self.append('not json\n' + json.dumps({'kind': 'weird', 'ts': 9e15}) + '\n' + line(body='ok'))
        self.assertEqual([e['body'] for e in t.read_new()], ['ok'])


if __name__ == '__main__':
    unittest.main()
