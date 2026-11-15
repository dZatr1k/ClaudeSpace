"""What the user has typed into Claude Code's input box, read from the tmux screen.

The box is drawn as a rule line, then «❯ text» (continuation lines indented), then another rule line. A grey (dim)
text after «❯» is a placeholder or a suggestion, not a draft. Used before a quick command: a draft would get the
command appended to it, so it is first put aside with Claude Code's own stash (Ctrl+S), which Claude Code restores by
itself once the command is submitted.
"""
import re

PROMPT = '❯'
_ESC = re.compile(r'\x1b(?:\[([0-9;:?]*)([A-Za-z])|\][^\x07\x1b]*(?:\x07|\x1b\\)|.)')


def _cells(line):
    """[(char, dim)] of one line of `capture-pane -e` output, escape sequences dropped."""
    out, dim, pos = [], False, 0
    for m in _ESC.finditer(line):
        out += [(c, dim) for c in line[pos:m.start()]]
        pos = m.end()
        if m.group(2) != 'm':
            continue
        params = (m.group(1) or '0').replace(':', ';').split(';')
        i = 0
        while i < len(params):
            p = params[i]
            if p in ('38', '48', '58'):  # extended colour: 5;n or 2;r;g;b
                i += 3 if i + 1 < len(params) and params[i + 1] == '5' else 5
                continue
            if p == '2':
                dim = True
            elif p in ('', '0', '22'):
                dim = False
            i += 1
    return out + [(c, dim) for c in line[pos:]]


def _text(cells):
    """the line without its dim parts"""
    return ''.join(c for c, d in cells if not d)


def _rule(plain):
    s = plain.strip()
    return len(s) >= 10 and set(s) == {'─'}


def draft(screen):
    """-> the draft text (empty string: the box is empty), or None if no input box is on the screen."""
    lines = [_cells(x) for x in screen.split('\n')]
    plain = [''.join(c for c, _ in x) for x in lines]
    for i in range(len(lines) - 1, 0, -1):
        if not plain[i].startswith(PROMPT) or not _rule(plain[i - 1]):
            continue
        parts = [_text(lines[i][1:])]
        for j in range(i + 1, len(lines)):
            if _rule(plain[j]):
                return '\n'.join(parts).strip()
            parts.append(_text(lines[j]))
        return None  # no closing rule: not the input box
    return None
