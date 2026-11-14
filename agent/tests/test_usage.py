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
