"""Files and Git panels (stage 5): fs_* and git_* through a real csagent, with a fake HOME. The deny-list must hold:
~/.ssh and Claude's secrets are never listed, read, offered for download or written to."""
import base64
import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
from tests import fixtures as fx  # noqa: E402

PNG = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + b'\0' * 8


def git(cwd, *args):
    env = {**os.environ, 'GIT_AUTHOR_NAME': 'T', 'GIT_AUTHOR_EMAIL': 't@example.com', 'GIT_COMMITTER_NAME': 'T',
           'GIT_COMMITTER_EMAIL': 't@example.com', 'HOME': cwd}
    subprocess.run(['git', '-C', cwd, *args], check=True, capture_output=True, env=env)


class FilesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fh = fx.FakeHome()
        h = cls.fh.home
        cls.proj = os.path.join(h, 'projects', 'repo')
        os.makedirs(os.path.join(cls.proj, 'src'))
        with open(os.path.join(cls.proj, 'README.md'), 'w') as f:
            f.write('# Repo\nпривет\n')
        with open(os.path.join(cls.proj, 'src', 'a.py'), 'w') as f:
            f.write('print(1)\n')
        with open(os.path.join(cls.proj, 'logo.png'), 'wb') as f:
            f.write(PNG)
        with open(os.path.join(cls.proj, 'blob.bin'), 'wb') as f:
            f.write(b'abc\0def')
        with open(os.path.join(cls.proj, 'big.txt'), 'w') as f:
            f.write('я' * 300_000)  # 600 KB of 2-byte chars: truncated at 512 KB on a char boundary
        os.symlink(os.path.join(h, '.ssh'), os.path.join(cls.proj, 'sshlink'))
        os.symlink(os.path.join(h, '.claude', '.credentials.json'), os.path.join(cls.proj, 'creds'))
        git(cls.proj, 'init', '-q', '-b', 'main')
        git(cls.proj, 'add', 'README.md', 'src/a.py')
        git(cls.proj, 'commit', '-qm', 'first commit')
        with open(os.path.join(cls.proj, 'src', 'a.py'), 'a') as f:
            f.write('print(2)\n')
        with open(os.path.join(cls.proj, 'new.txt'), 'w') as f:
            f.write('fresh\n')
        git(cls.proj, 'add', 'new.txt')
        with open(os.path.join(cls.proj, 'untracked.md'), 'w') as f:
            f.write('u\n')
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

    def test_list(self):
        r = self.ok('fs_list', {'path': self.proj})
        names = [e['name'] for e in r['entries']]
        self.assertEqual(names[:2], ['.git', 'src'])  # folders first
        self.assertIn('README.md', names)
        self.assertNotIn('sshlink', names)  # resolves into ~/.ssh
        self.assertNotIn('creds', names)
        readme = next(e for e in r['entries'] if e['name'] == 'README.md')
        self.assertEqual(readme['type'], 'file')
        self.assertGreater(readme['size'], 0)

    def test_list_denied_and_outside(self):
        self.assertEqual(self.err('fs_list', {'path': os.path.join(self.fh.home, '.ssh')}), 'not_allowed')
        self.assertEqual(self.err('fs_list', {'path': '/etc'}), 'not_allowed')
        self.assertEqual(self.err('fs_list', {'path': self.proj + '/../../..'}), 'not_allowed')
        self.assertEqual(self.err('fs_list', {'path': os.path.join(self.proj, 'nope')}), 'not_found')
        claude = self.ok('fs_list', {'path': os.path.join(self.fh.home, '.claude')})
        names = [e['name'] for e in claude['entries']]
        for secret in ('.credentials.json', 'settings.local.json', 'history.jsonl'):
            self.assertNotIn(secret, names)

    def test_read(self):
        t = self.ok('fs_read', {'path': os.path.join(self.proj, 'README.md')})
        self.assertEqual((t['kind'], t['text'], t['truncated']), ('text', '# Repo\nпривет\n', False))
        img = self.ok('fs_read', {'path': os.path.join(self.proj, 'logo.png')})
        self.assertEqual((img['kind'], img['mime']), ('image', 'image/png'))
        self.assertEqual(base64.b64decode(img['data']), PNG)
        self.assertEqual(self.ok('fs_read', {'path': os.path.join(self.proj, 'blob.bin')})['kind'], 'binary')
        big = self.ok('fs_read', {'path': os.path.join(self.proj, 'big.txt')})
        self.assertTrue(big['truncated'])
        self.assertNotIn('�', big['text'])
        self.assertEqual(len(big['text'].encode()), 512 * 1024)

    def test_read_denied(self):
        for p in self.fh.secrets + [os.path.join(self.proj, 'creds'), os.path.join(self.proj, 'sshlink', 'config')]:
            self.assertEqual(self.err('fs_read', {'path': p}), 'not_allowed', p)
            self.assertEqual(self.err('fs_download_source', {'path': p}), 'not_allowed', p)
        self.assertEqual(self.err('fs_read', {'path': self.proj}), 'bad_request')

    def test_upload_target(self):
        r = self.ok('fs_upload_target', {'dir': self.proj, 'name': 'shot.png'})
        self.assertEqual(r, {'path': os.path.join(self.proj, 'shot.png'), 'exists': False})
        self.assertTrue(self.ok('fs_upload_target', {'dir': self.proj, 'name': 'README.md'})['exists'])
        for bad in ('../x', 'a/b', '..', '.', ''):
            self.assertEqual(self.err('fs_upload_target', {'dir': self.proj, 'name': bad}), 'bad_request', bad)
        self.assertEqual(self.err('fs_upload_target', {'dir': self.proj, 'name': 'src'}), 'bad_request')
        self.assertEqual(
            self.err('fs_upload_target', {'dir': os.path.join(self.fh.home, '.ssh'), 'name': 'authorized_keys'}),
            'not_allowed')
        self.assertEqual(
            self.err('fs_upload_target', {'dir': os.path.join(self.fh.home, '.claude'), 'name': 'settings.local.json'}),
            'not_allowed')

    def test_download_source(self):
        r = self.ok('fs_download_source', {'path': os.path.join(self.proj, 'README.md')})
        self.assertEqual(r['path'], os.path.join(self.proj, 'README.md'))

    def test_git_status(self):
        s = self.ok('git_status', {'path': os.path.join(self.proj, 'src')})
        self.assertEqual((s['root'], s['branch']), (self.proj, 'main'))
        by = {f['path']: f for f in s['files']}
        self.assertEqual(by['src/a.py']['unstaged'], 'modified')
        self.assertEqual(by['new.txt']['staged'], 'added')
        self.assertTrue(by['untracked.md']['untracked'])
        self.assertEqual(self.ok('git_status', {'path': os.path.join(self.fh.home, 'projects')}), {'root': None})

    def test_git_diff(self):
        d = self.ok('git_diff', {'path': self.proj, 'file': 'src/a.py'})
        self.assertIn('+print(2)', d['diff'])
        staged = self.ok('git_diff', {'path': self.proj, 'file': 'new.txt', 'staged': True})
        self.assertIn('+fresh', staged['diff'])
        u = self.ok('git_diff', {'path': self.proj, 'file': 'untracked.md', 'untracked': True})
        self.assertIn('+u', u['diff'])
        self.assertEqual(self.err('git_diff', {'path': self.proj, 'file': '../../.ssh/config'}), 'not_allowed')
        self.assertEqual(self.err('git_diff', {'path': self.proj, 'file': '/etc/passwd'}), 'bad_request')
        self.assertEqual(self.err('git_diff', {'path': self.proj, 'file': 'creds', 'untracked': True}), 'not_allowed')

    def test_git_log(self):
        log = self.ok('git_log', {'path': self.proj})
        self.assertEqual([c['subject'] for c in log['commits']], ['first commit'])
        self.assertEqual(log['commits'][0]['author'], 'T')

    def test_git_show(self):
        c = self.ok('git_log', {'path': self.proj})['commits'][0]
        for h in (c['hash'], c['short']):
            r = self.ok('git_show', {'path': self.proj, 'hash': h})
            self.assertIn('first commit', r['diff'])
            self.assertIn('src/a.py', r['diff'])     # --stat line and the patch
            self.assertIn('+print(1)', r['diff'])
        for bad in ('HEAD', '--all', 'abc', 'g' * 40, '1234567;ls'):
            self.assertEqual(self.err('git_show', {'path': self.proj, 'hash': bad}), 'bad_request', bad)
        self.assertEqual(self.err('git_show', {'path': self.proj, 'hash': '0' * 40}), 'not_found')


if __name__ == '__main__':
    unittest.main()
