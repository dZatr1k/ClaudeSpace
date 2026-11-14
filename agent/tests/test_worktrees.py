"""Parallel tasks in git worktrees: git_worktrees / worktree_create / worktree_remove through a real csagent."""
import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
from cclib import paths, projects  # noqa: E402
from tests import fixtures as fx  # noqa: E402

ENV = {'GIT_AUTHOR_NAME': 'T', 'GIT_AUTHOR_EMAIL': 't@example.com', 'GIT_COMMITTER_NAME': 'T',
       'GIT_COMMITTER_EMAIL': 't@example.com'}


def git(cwd, *args):
    return subprocess.run(['git', '-C', cwd, *args], check=True, capture_output=True, text=True,
                          env={**os.environ, **ENV}).stdout


class WorktreeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fh = fx.FakeHome()
        fx.kill_tmux_server()
        cls.repo = cls.fh.alpha
        git(cls.repo, 'add', 'CLAUDE.md')
        git(cls.repo, 'commit', '-qm', 'first')
        cls.ag = fx.AgentProc(cls.fh)
        cls.ag.wait_event('hello')

    @classmethod
    def tearDownClass(cls):
        cls.ag.close()
        fx.kill_tmux_server()
        cls.fh.cleanup()

    def ok(self, method, params):
        r = self.ag.call(method, params, timeout=30)
        self.assertIn('result', r, (method, params, r))
        return r['result']

    def err(self, method, params):
        r = self.ag.call(method, params, timeout=30)
        self.assertIn('error', r, (method, params, r))
        return r['error']['code']

    def test_lifecycle(self):
        r = self.ok('worktree_create', {'path': self.repo, 'branch': 'fix/login'})
        wt = os.path.join(self.repo, '.claude', 'worktrees', 'fix-login')
        self.assertEqual((r['path'], r['branch'], r['created']), (wt, 'fix/login', True))
        self.assertTrue(os.path.isfile(os.path.join(wt, 'CLAUDE.md')))
        # the main checkout's status stays clean: .claude/worktrees is excluded locally
        self.assertEqual(git(self.repo, 'status', '--porcelain'), '')
        with open(os.path.join(self.repo, '.git', 'info', 'exclude')) as f:
            self.assertIn('/.claude/worktrees/', f.read())
        # listed from the main checkout and from inside the worktree
        for d in (self.repo, wt):
            ls = self.ok('git_worktrees', {'path': d})
            self.assertEqual(ls['main'], self.repo)
            self.assertEqual([(w['path'], w['branch'], w['ours'], w['dirty']) for w in ls['worktrees']],
                             [(wt, 'fix/login', True, 0)])
        self.assertEqual(self.ok('git_worktrees', {'path': wt})['current'], wt)
        # same branch twice / bad names / unknown base
        self.assertEqual(self.err('worktree_create', {'path': self.repo, 'branch': 'fix/login'}), 'exists')
        for bad in ('-x', 'a..b', 'a b', 'a;rm', '', 'x' * 61, 'a/', '.hidden/'):
            self.assertEqual(self.err('worktree_create', {'path': self.repo, 'branch': bad}), 'bad_request', bad)
        self.assertEqual(self.err('worktree_create', {'path': self.repo, 'branch': 'n', 'base': 'nope'}), 'not_found')
        # uncommitted change: refused without force
        with open(os.path.join(wt, 'new.txt'), 'w') as f:
            f.write('x\n')
        self.assertEqual(self.err('worktree_remove', {'path': self.repo, 'worktree': wt}), 'dirty')
        # a tmux session working inside: refused even with force
        fx.tmux('new-session', '-d', '-s', 'wt', '-c', wt, 'sleep 60')
        try:
            self.assertEqual(self.err('worktree_remove', {'path': self.repo, 'worktree': wt, 'force': True}), 'busy')
        finally:
            fx.tmux('kill-session', '-t', '=wt')
        # never the main checkout or a random folder
        self.assertEqual(self.err('worktree_remove', {'path': self.repo, 'worktree': self.repo}), 'not_found')
        self.assertEqual(self.err('worktree_remove', {'path': self.repo, 'worktree': self.fh.beta}), 'not_found')
        # force removes; the unmerged-but-identical branch is merged, so -d deletes it
        r = self.ok('worktree_remove', {'path': self.repo, 'worktree': wt, 'force': True, 'deleteBranch': True})
        self.assertEqual((r['removed'], r['branchDeleted']), (True, True))
        self.assertFalse(os.path.exists(wt))
        self.assertEqual(self.ok('git_worktrees', {'path': self.repo})['worktrees'], [])

    def test_unmerged_branch_is_kept(self):
        r = self.ok('worktree_create', {'path': self.repo, 'branch': 'feat', 'base': 'main'})
        git(r['path'], 'commit', '-q', '--allow-empty', '-m', 'work')
        r = self.ok('worktree_remove', {'path': self.repo, 'worktree': r['path'], 'deleteBranch': True})
        self.assertEqual(r['branchDeleted'], False)
        self.assertIn('не влита', r['branchKept'])
        self.assertIn('feat', git(self.repo, 'branch'))
        # an existing branch is checked out again (created: False)
        r = self.ok('worktree_create', {'path': self.repo, 'branch': 'feat'})
        self.assertFalse(r['created'])
        self.ok('worktree_remove', {'path': self.repo, 'worktree': r['path']})

    def test_display_name(self):
        paths.reset(self.fh.home)
        try:
            self.assertEqual(projects.display_name(os.path.join(self.repo, '.claude', 'worktrees', 'fix-login')),
                             'Alpha › fix-login')
        finally:
            paths.reset()


if __name__ == '__main__':
    unittest.main()
