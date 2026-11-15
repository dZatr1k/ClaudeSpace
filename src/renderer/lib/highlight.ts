// Syntax highlighting for the file viewer: highlight.js core with a fixed set of languages (no auto-detection, so a
// file is highlighted only when its extension says what it is). Output is split into lines so the viewer keeps its
// line numbers; a token that spans lines (a block comment) is closed and reopened at each line break.
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import lua from 'highlight.js/lib/languages/lua';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGS = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  makefile,
  markdown,
  php,
  powershell,
  python,
  ruby,
  rust,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def);

const BY_EXT: Record<string, string> = {
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  csx: 'csharp',
  css: 'css',
  diff: 'diff',
  patch: 'diff',
  go: 'go',
  ini: 'ini',
  toml: 'ini',
  cfg: 'ini',
  conf: 'ini',
  editorconfig: 'ini',
  properties: 'ini',
  java: 'java',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  kt: 'kotlin',
  kts: 'kotlin',
  lua: 'lua',
  mk: 'makefile',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  php: 'php',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sql: 'sql',
  swift: 'swift',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  csproj: 'xml',
  props: 'xml',
  targets: 'xml',
  sln: 'ini',
  xaml: 'xml',
  vue: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  tscn: 'ini',
  tres: 'ini',
  godot: 'ini',
  gd: 'python',
};
const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  '.bashrc': 'bash',
  '.bash_profile': 'bash',
  '.profile': 'bash',
  '.zshrc': 'bash',
  '.gitconfig': 'ini',
  '.env': 'bash',
};

/** larger files are shown as plain text: highlighting them would freeze the window */
export const MAX_HIGHLIGHT = 300_000;

/** highlight.js language for a file path, or null */
export function languageFor(path: string): string | null {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith('dockerfile.')) return 'dockerfile';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? (BY_EXT[name.slice(dot + 1)] ?? null) : null;
}

/** Split highlight.js HTML into lines, closing the spans open at a line end and reopening them on the next line. */
export function splitHtmlLines(html: string): string[] {
  const out: string[] = [];
  const open: string[] = [];
  let cur = '';
  const re = /<span[^>]*>|<\/span>|\n/g;
  let pos = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    cur += html.slice(pos, m.index);
    pos = m.index + m[0].length;
    if (m[0] === '\n') {
      out.push(cur + '</span>'.repeat(open.length));
      cur = open.join('');
    } else if (m[0] === '</span>') {
      open.pop();
      cur += m[0];
    } else {
      open.push(m[0]);
      cur += m[0];
    }
  }
  out.push(cur + html.slice(pos));
  return out;
}

/** highlighted HTML per line (escaped by highlight.js), or null: unknown language, too large, or it failed */
export function highlightLines(text: string, lang: string | null): string[] | null {
  if (!lang || text.length > MAX_HIGHLIGHT || !hljs.getLanguage(lang)) return null;
  try {
    const body = text.endsWith('\n') ? text.slice(0, -1) : text;
    return splitHtmlLines(hljs.highlight(body, { language: lang, ignoreIllegals: true }).value);
  } catch {
    return null;
  }
}
