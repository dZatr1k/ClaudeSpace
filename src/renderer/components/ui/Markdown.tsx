// Markdown as it is written on GitHub and by Claude (GFM): tables, ~~strikethrough~~, task lists, bare links,
// footnotes. Raw HTML and images are dropped: the text comes from files and chats on the VM.
import ReactMarkdown from 'react-markdown';
import type { Components, Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { t } from '../../i18n/ru';

const remarkPlugins = [remarkGfm];
const remarkRehypeOptions: Options['remarkRehypeOptions'] = {
  footnoteLabel: t.md.footnotes,
  footnoteBackLabel: (i: number) => t.md.footnoteBack(i + 1),
};

/** a wide table scrolls inside its own box instead of stretching the panel or the viewer */
const table: Components['table'] = ({ node: _node, ...props }) => (
  <div className="md-table">
    <table {...props} />
  </div>
);

/** YAML front matter (skills, memory notes) as a fenced yaml block. Left as markdown, its `---` lines turn into a
 * rule and a heading that run the fields together. The fence is longer than any backtick run inside. */
export function frontMatterAsCode(text: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return text;
  const yaml = m[1] ?? '';
  const longest = Math.max(0, ...(yaml.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}yaml\n${yaml}\n${fence}\n\n${text.slice(m[0].length)}`;
}

export function Markdown({ children, components }: { children: string; components?: Components }) {
  return (
    <ReactMarkdown
      skipHtml
      disallowedElements={['img']}
      unwrapDisallowed
      remarkPlugins={remarkPlugins}
      remarkRehypeOptions={remarkRehypeOptions}
      components={{ table, ...components }}
    >
      {children}
    </ReactMarkdown>
  );
}
