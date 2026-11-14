"""cclib.usage: ccusage is found and runs although ~/.local/bin is not on PATH (SSH exec); failures are reported."""
import json
import os
import shutil
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
from cclib import paths, usage  # noqa: E402
from tests import fixtures as fx  # noqa: E402

FAKE_NODE = """#!/bin/sh
# stands in for node: runs the "script" with sh
exec /bin/sh "$@"
"""

# like the real ccusage: a script whose interpreter is only in ~/.local/bin
FAKE_CCUSAGE = """#!/usr/bin/env fakenode
case "$1" in
  blocks) echo '{"blocks":[{"totalTokens":1234,"costUSD":0.5,"endTime":"2099-01-01T00:00:00Z","models":["m"]}]}' ;;
  daily)  echo '{"daily":[{"date":"2026-11-09","totalTokens":5000,"totalCost":1.5}],"totals":{"totalTokens":5000}}' ;;
esac
"""


class UsageTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix='cs-usage-')
        self.bin = os.path.join(self.home, '.local', 'bin')
        os.makedirs(self.bin)
        self.old_path = os.environ.get('PATH', '')
        for k in ('XDG_CACHE_HOME', 'XDG_STATE_HOME'):
            os.environ.pop(k, None)
        paths.reset(self.home)
        os.environ['PATH'] = '/usr/bin:/bin'  # what a non-login SSH exec gets

    def tearDown(self):
        os.environ['PATH'] = self.old_path
        paths.reset()
        shutil.rmtree(self.home, ignore_errors=True)

    def write(self, name, body):
        p = os.path.join(self.bin, name)
        with open(p, 'w') as f:
            f.write(body)
        os.chmod(p, stat.S_IRWXU)

    def test_runs_node_script_without_local_bin_on_path(self):
        self.write('fakenode', FAKE_NODE)
        self.write('ccusage', FAKE_CCUSAGE)
        r = usage.usage(max_age=0)
        self.assertTrue(r['ok'], r)
        self.assertEqual(r['weekTokens'], 5000)
        self.assertEqual(r['block']['tokens'], 1234)
        with open(paths.P.usage_cache) as f:
            self.assertTrue(json.load(f)['ok'])

    def test_failure_is_an_error_not_zero_usage_and_not_cached(self):
        self.write('ccusage', '#!/usr/bin/env missing-interpreter\n')
        r = usage.usage(max_age=0)
        self.assertFalse(r['ok'])
        self.assertIn('ccusage', r['error'])
        self.assertFalse(os.path.exists(paths.P.usage_cache))

    def test_not_installed(self):
        r = usage.usage(max_age=0)
        self.assertFalse(r['ok'])
        self.assertEqual(r['error'], 'ccusage не установлен')


if __name__ == '__main__':
    unittest.main()


class ReportTest(unittest.TestCase):
    def test_build_report(self):
        import time as _t
        from cclib import paths, usage
        fh = fx.FakeHome()
        paths.reset(fh.home)
        try:
            now = _t.mktime((2026, 11, 14, 12, 0, 0, 0, 0, -1))
            daily = {'daily': [
                {'period': '2026-11-14', 'totalTokens': 300, 'totalCost': 3.0,
                 'modelBreakdowns': [{'modelName': 'opus', 'inputTokens': 100, 'outputTokens': 100,
                                      'cacheReadTokens': 50, 'cacheCreationTokens': 50, 'cost': 3.0}]},
                {'period': '2026-11-01', 'totalTokens': 999, 'totalCost': 9},   # before the period: dropped
            ]}
            sessions = {'session': [
                {'period': 'a', 'totalTokens': 200, 'totalCost': 2},
                {'period': 'b', 'totalTokens': 50, 'totalCost': 0.5},
                {'period': 'zzz', 'totalTokens': 50, 'totalCost': 0.5},   # chat not known: «other»
            ]}
            blocks = {'blocks': [
                {'isGap': True, 'startTime': '2026-11-14T00:00:00Z', 'endTime': '2026-11-14T05:00:00Z'},
                {'startTime': '2026-11-14T10:00:00Z', 'endTime': '2026-11-14T15:00:00Z', 'totalTokens': 300,
                 'costUSD': 3, 'isActive': True, 'burnRate': {'tokensPerMinute': 5, 'costPerHour': 1},
                 'projection': {'totalTokens': 900, 'totalCost': 9}, 'models': ['opus']},
            ]}
            alpha = os.path.join(fh.home, 'projects', 'Alpha')
            r = usage.build_report(daily, sessions, blocks, {'a': alpha, 'b': alpha}, 7, now=now)
            self.assertEqual([d['day'] for d in r['daily']][-1], '2026-11-14')
            self.assertEqual(len(r['daily']), 7)
            self.assertEqual(r['daily'][-1]['models'], {'opus': 300})
            self.assertEqual(r['daily'][0]['tokens'], 0)
            self.assertEqual(r['totalTokens'], 300)
            self.assertEqual([(p['label'], p['tokens'], p['chats']) for p in r['projects']],
                             [('Alpha', 250, 2), (None, 50, 1)])
            self.assertEqual(r['models'], [{'name': 'opus', 'tokens': 300, 'costUsd': 3.0}])
            self.assertEqual(len(r['blocks']), 1)
            self.assertEqual((r['active']['projectedTokens'], r['active']['tpm']), (900, 5))
        finally:
            paths.reset()
            fh.cleanup()
