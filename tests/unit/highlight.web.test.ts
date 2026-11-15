import { describe, expect, it } from 'vitest';
import { highlightLines, languageFor, MAX_HIGHLIGHT, splitHtmlLines } from '../../src/renderer/lib/highlight';

describe('languageFor', () => {
  it('maps extensions and well-known names', () => {
    expect(languageFor('/a/b/main.py')).toBe('python');
    expect(languageFor('src/App.TSX')).toBe('typescript');
    expect(languageFor('Program.cs')).toBe('csharp');
    expect(languageFor('/x/Dockerfile')).toBe('dockerfile');
    expect(languageFor('Dockerfile.dev')).toBe('dockerfile');
    expect(languageFor('~/.bashrc')).toBe('bash');
    expect(languageFor('notes.txt')).toBeNull();
    expect(languageFor('LICENSE')).toBeNull();
  });
});

describe('splitHtmlLines', () => {
  it('closes and reopens a span that crosses a line break', () => {
    expect(splitHtmlLines('a<span class="c">/* x\ny */</span>b')).toEqual([
      'a<span class="c">/* x</span>',
      '<span class="c">y */</span>b',
    ]);
  });
  it('handles nested spans and empty lines', () => {
    expect(splitHtmlLines('<span class="a"><span class="b">1\n\n2</span></span>')).toEqual([
      '<span class="a"><span class="b">1</span></span>',
      '<span class="a"><span class="b"></span></span>',
      '<span class="a"><span class="b">2</span></span>',
    ]);
  });
});

describe('highlightLines', () => {
  it('keeps one entry per line and escapes the text', () => {
    const src = 'def f(x):\n    """doc\n    more"""\n    return "<b>"\n';
    const lines = highlightLines(src, 'python')!;
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('hljs-keyword');
    expect(lines[3]).toContain('&lt;b&gt;');
    expect(lines.join('')).not.toContain('<b>');
  });
  it('skips unknown languages and very large files', () => {
    expect(highlightLines('x', null)).toBeNull();
    expect(highlightLines('x', 'brainfuck')).toBeNull();
    expect(highlightLines('a'.repeat(MAX_HIGHLIGHT + 1), 'python')).toBeNull();
  });
});
