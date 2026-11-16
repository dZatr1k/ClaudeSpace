import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown, frontMatterAsCode } from '../../src/renderer/components/ui/Markdown';

const html = (src: string) => renderToStaticMarkup(createElement(Markdown, { children: src }));

describe('Markdown (GFM)', () => {
  it('renders a pipe table inside its scroll box, with column alignment', () => {
    const out = html('| Pattern | Signs |\n|---|:-:|\n| **Glow** | everywhere |\n');
    expect(out).toContain('<div class="md-table"><table>');
    expect(out).toContain('<th>Pattern</th>');
    expect(out).toContain('<td><strong>Glow</strong></td>');
    expect(out).toMatch(/<td style="text-align:center">everywhere<\/td>/);
    expect(out).not.toContain('|');
  });

  it('renders strikethrough, task lists and bare links', () => {
    const out = html('~~old~~\n\n- [x] done\n- [ ] todo\n\nsee https://example.com/docs');
    expect(out).toContain('<del>old</del>');
    expect(out).toContain('class="contains-task-list"');
    expect(out).toMatch(/<input type="checkbox" disabled="" checked=""\/> done/);
    expect(out).toContain('<a href="https://example.com/docs">https://example.com/docs</a>');
  });

  it('labels footnotes in Russian', () => {
    const out = html('Текст[^1]\n\n[^1]: Сноска.');
    expect(out).toContain('>Сноски</h2>');
    expect(out).toContain('aria-label="Вернуться к сноске 1 в тексте"');
  });

  it('still drops raw HTML and images', () => {
    const out = html('<script>x()</script>\n\n![pic](https://example.com/a.png) после');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).toContain('<p> после</p>');
  });
});

describe('frontMatterAsCode', () => {
  it('turns the front matter into a yaml block and keeps the body', () => {
    expect(frontMatterAsCode('---\nname: review\ndescription: x\n---\n\n# Body\n')).toBe(
      '```yaml\nname: review\ndescription: x\n```\n\n\n# Body\n',
    );
    expect(html(frontMatterAsCode('---\nname: a\n---\ntext'))).not.toContain('<hr');
  });
  it('uses a longer fence when the yaml has backticks, handles CRLF, leaves other text alone', () => {
    expect(frontMatterAsCode('---\nx: "```"\n---\n')).toBe('````yaml\nx: "```"\n````\n\n');
    expect(frontMatterAsCode('---\r\nname: a\r\n---\r\nbody')).toBe('```yaml\nname: a\n```\n\nbody');
    expect(frontMatterAsCode('text\n---\nmore\n---\n')).toBe('text\n---\nmore\n---\n');
    expect(frontMatterAsCode('---\n\n# rule, not front matter')).toBe('---\n\n# rule, not front matter');
  });
});
