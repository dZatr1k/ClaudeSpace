"""Reading the draft in Claude Code's input box from `tmux capture-pane -e` (screens taken from Claude Code 2.1)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
from cclib.claudeinput import draft  # noqa: E402

RULE = '\x1b[37m' + '─' * 40
FOOT = '\x1b[39m  \x1b[38;5;155m⎇ main\x1b[38;5;59m | \x1b[38;5;70m+0\x1b[39m\n  \x1b[93m⏵⏵ auto mode on\x1b[2m\x1b[37m (x)\x1b[0m'


def screen(*box, above='● some answer\n❯ an old prompt in the history'):
    return '\n'.join([above, RULE, *box, RULE, FOOT])


class DraftTest(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(draft(screen('\x1b[39m❯\xa0')), '')
        self.assertEqual(draft(screen('\x1b[2m❯\xa0\x1b[0m')), '')  # unfocused pane: the prompt is grey

    def test_placeholder_and_suggestion_are_not_a_draft(self):
        self.assertEqual(draft(screen('\x1b[39m❯\xa0\x1b[2mTry "fix lint errors"\x1b[0m')), '')
        self.assertEqual(draft(screen('\x1b[39m❯\xa0\x1b[2mок, жду\x1b[0m')), '')

    def test_draft(self):
        self.assertEqual(draft(screen('\x1b[39m❯\xa0черновик draft')), 'черновик draft')
        self.assertEqual(draft(screen('\x1b[2m❯\xa0\x1b[0mtext')), 'text')

    def test_multiline_draft(self):
        self.assertEqual(draft(screen('\x1b[39m❯\xa0', '  line two')), 'line two')
        self.assertEqual(draft(screen('\x1b[39m❯\xa0one', '  two')), 'one\n  two')

    def test_colour_codes_do_not_count_as_dim(self):
        # 38;5;2 is a colour (green), not «dim»
        self.assertEqual(draft(screen('\x1b[38;5;2m❯\xa0x\x1b[0m')), 'x')
        self.assertEqual(draft(screen('\x1b[38;2;2;2;2m❯\xa0y\x1b[0m')), 'y')

    def test_no_box(self):
        self.assertIsNone(draft('$ ls\nfile\n$ '))
        self.assertIsNone(draft('\n'.join([RULE, '\x1b[39m❯\xa0open box'])))  # no closing rule
        self.assertIsNone(draft(''))


if __name__ == '__main__':
    unittest.main()
