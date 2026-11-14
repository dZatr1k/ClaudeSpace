"""The «Claude» screen: claude_config (overview) and claude_doc_write through a real csagent with a fake HOME.
MCP secrets (env values, extra args, URL paths) never leave the agent; writes only to CLAUDE.md and memory notes."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
from cclib import chats  # noqa: E402
from tests import fixtures as fx  # noqa: E402

KEY = 'sk-live-should-never-leave'


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(text)


class ClaudeCfgTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fh = fx.FakeHome()
        h, a = cls.fh.home, cls.fh.alpha
        cd = os.path.join(h, '.claude')
        cls.cd = cd
        write(os.path.join(cd, 'CLAUDE.md'), '# Global\n')
        write(os.path.join(h, '.claude.json'), json.dumps({
            'oauthAccount': {'emailAddress': 'x@example.com'},
            'mcpServers': {
                'playwright': {'type': 'stdio', 'command': '/usr/bin/npx',
                               'args': ['@playwright/mcp@latest', '--token', KEY], 'env': {'API_KEY': KEY}},
                'remote': {'type': 'http', 'url': f'https://user:{KEY}@mcp.example.com/v1?key={KEY}'},
            },
            'projects': {a: {'mcpServers': {'local-db': {'command': 'uvx', 'args': [f'--key={KEY}', 'db-mcp']}}}},
        }))
        write(os.path.join(a, '.mcp.json'), json.dumps({'mcpServers': {'shared': {'command': 'node',
                                                                                    'args': ['srv.js']}}}))
        write(os.path.join(cd, 'settings.json'), json.dumps({
            'enabledPlugins': {'good@market': True, 'off@market': False},
            'hooks': {'Stop': [{'hooks': [{'type': 'command', 'command': '~/.claude/hooks/notify.sh',
                                           'timeout': 20, 'async': True}]}]},
        }))
        plug = os.path.join(cd, 'plugins', 'cache', 'market', 'good', '1.0.0')
        write(os.path.join(plug, 'skills', 'polish', 'SKILL.md'),
              '---\nname: polish\ndescription: "Make text better"\n---\n# body\n')
        write(os.path.join(plug, 'hooks', 'hooks.json'), json.dumps(
            {'hooks': {'PreToolUse': [{'matcher': 'Bash', 'hooks': [{'type': 'command', 'command': 'check.sh'}]}]}}))
        write(os.path.join(cd, 'plugins', 'installed_plugins.json'), json.dumps({'version': 2, 'plugins': {
            'good@market': [{'scope': 'user', 'installPath': plug, 'version': '1.0.0'}],
            'off@market': [{'scope': 'user', 'installPath': '/etc', 'version': '2.0'}]}}))
        write(os.path.join(cd, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: My own skill\n---\n')
        mem = os.path.join(cd, 'projects', chats.encode_dir(a), 'memory')
        cls.mem = mem
        write(os.path.join(mem, 'MEMORY.md'), '- [Fact](fact.md) — a fact\n')
        write(os.path.join(mem, 'fact.md'), '---\nname: fact\ndescription: A fact\nmetadata:\n  type: user\n---\nX\n')
        cls.ag = fx.AgentProc(cls.fh)
        cls.ag.wait_event('hello')

    @classmethod
    def tearDownClass(cls):
        cls.ag.close()
        cls.fh.cleanup()

    def ok(self, method, params):
        r = self.ag.call(method, params)
        self.assertIn('result', r, (method, params, r))
        return r['result']

    def err(self, method, params):
        r = self.ag.call(method, params)
        self.assertIn('error', r, (method, params, r))
        return r['error']['code']

    def test_overview(self):
        a = self.fh.alpha
        r = self.ok('claude_config', {'path': os.path.join(a, 'sub')})
        self.assertNotIn(KEY, json.dumps(r))
        self.assertNotIn('x@example.com', json.dumps(r))
        self.assertEqual((r['folder'], r['root']), (os.path.join(a, 'sub'), a))
        ins = {(i['scope'], i['path']): i['exists'] for i in r['instructions']}
        self.assertTrue(ins[('user', os.path.join(self.cd, 'CLAUDE.md'))])
        self.assertFalse(ins[('project', os.path.join(a, 'sub', 'CLAUDE.md'))])   # offered for creation
        self.assertTrue(ins[('parent', os.path.join(a, 'CLAUDE.md'))])
        mcp = {m['name']: m for m in r['mcp']}
        self.assertEqual(mcp['playwright']['target'], 'npx @playwright/mcp@latest')
        self.assertEqual(mcp['playwright']['env'], 1)
        self.assertEqual(mcp['remote']['target'], 'https://mcp.example.com')
        self.assertEqual((mcp['local-db']['scope'], mcp['local-db']['target']), ('local', 'uvx db-mcp'))
        self.assertEqual(mcp['shared']['scope'], 'project')
        skills = {(s['scope'], s['name']): s for s in r['skills']}
        self.assertEqual(skills[('plugin', 'polish')]['description'], 'Make text better')
        self.assertIn(('user', 'mine'), skills)
        pl = {p['id']: p for p in r['plugins']}
        self.assertTrue(pl['good@market']['enabled'])
        self.assertFalse(pl['off@market']['enabled'])
        self.assertIsNone(pl['off@market']['path'])           # outside ~/.claude/plugins: not followed
        hooks = {(h['scope'], h['event']): h for h in r['hooks']}
        self.assertEqual(hooks[('user', 'Stop')]['timeout'], 20)
        self.assertEqual(hooks[('plugin', 'PreToolUse')]['matcher'], 'Bash')
        mem = r['memory'][0]
        self.assertEqual((mem['label'], mem['current']), ('Alpha', False))   # ctx is Alpha/sub, not Alpha
        self.assertEqual([f['name'] for f in mem['files']], ['MEMORY.md', 'fact.md'])
        self.assertEqual(mem['files'][1]['description'], 'A fact')
        # no folder: user-level only
        r = self.ok('claude_config', {})
        self.assertEqual([i['scope'] for i in r['instructions']], ['user'])

    def test_write_and_conflict(self):
        p = os.path.join(self.cd, 'CLAUDE.md')
        st = self.ok('fs_read', {'path': p})
        w = self.ok('claude_doc_write', {'path': p, 'text': '# Global\nновое\n', 'mtime': st['mtime']})
        with open(p) as f:
            self.assertEqual(f.read(), '# Global\nновое\n')
        # the editor still has the old mtime: refused, file untouched
        self.assertEqual(self.err('claude_doc_write', {'path': p, 'text': 'stale', 'mtime': st['mtime'] - 5000}),
                         'conflict')
        self.ok('claude_doc_write', {'path': p, 'text': '# v3\n', 'mtime': w['mtime']})
        # a new project CLAUDE.md: mtime null creates it; a second create is a conflict
        np = os.path.join(self.fh.beta, 'CLAUDE.md')
        self.ok('claude_doc_write', {'path': np, 'text': '# Beta\n', 'mtime': None})
        self.assertEqual(self.err('claude_doc_write', {'path': np, 'text': 'x'}), 'conflict')
        # memory note
        mp = os.path.join(self.mem, 'fact.md')
        st = self.ok('fs_read', {'path': mp})
        self.ok('claude_doc_write', {'path': mp, 'text': st['text'] + 'Y\n', 'mtime': st['mtime']})

    def test_write_whitelist(self):
        h = self.fh.home
        link = os.path.join(self.fh.beta, 'CLAUDE.local.md')
        os.symlink(os.path.join(h, '.claude', 'settings.local.json'), link)
        for bad in (os.path.join(self.cd, 'settings.json'), os.path.join(self.cd, 'settings.local.json'),
                    os.path.join(self.cd, '.credentials.json'), os.path.join(h, '.ssh', 'CLAUDE.md'),
                    os.path.join(h, '.bashrc'), os.path.join(self.fh.alpha, 'main.py'),
                    os.path.join(self.cd, 'skills', 'mine', 'CLAUDE.md'), '/tmp/CLAUDE.md', link,
                    os.path.join(self.mem, '..', 'x.jsonl'), os.path.join(self.mem, 'a b;.md'),
                    os.path.join(self.fh.alpha, 'nope', 'CLAUDE.md')):
            code = self.err('claude_doc_write', {'path': bad, 'text': 'x', 'mtime': None})
            self.assertIn(code, ('not_allowed', 'not_found'), bad)
        for p in self.fh.secrets:
            with open(p) as f:
                self.assertIn(fx.SECRET, f.read())
        self.assertEqual(self.err('claude_doc_write', {'path': os.path.join(self.fh.beta, 'CLAUDE.local.md'),
                                                       'text': 'x', 'mtime': 'yesterday'}), 'bad_request')


if __name__ == '__main__':
    unittest.main()
