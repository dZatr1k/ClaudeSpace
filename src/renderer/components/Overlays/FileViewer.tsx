// File / diff viewer (stage 5) over the window: text with line numbers, markdown (rendered or as text), images,
// a note for binaries; git diffs coloured by line. Esc closes it (Modal). Actions: paste the path into the chat,
// download to the PC, open in VS Code.
import { Code, Download, FileText, TextCursorInput } from 'lucide-react';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { FsFile, MethodResults } from '@shared/protocol';
import { openVsCode } from '../../actions';
import { agent } from '../../bridge';
import { t } from '../../i18n/ru';
import { basename, formatAgo, formatBytes } from '../../lib/format';
import { downloadFile, homeShort, pastePathToChat } from '../../lib/files';
import { useUi } from '../../stores/ui';
import type { Viewer } from '../../stores/ui';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';

type Loaded<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; data: T };

function useLoad<T>(key: string, fn: () => Promise<T>): Loaded<T> {
  const [st, setSt] = useState<Loaded<T>>({ state: 'loading' });
  useEffect(() => {
    let alive = true;
    setSt({ state: 'loading' });
    fn().then(
      (data) => alive && setSt({ state: 'ok', data }),
      (e: Error) => alive && setSt({ state: 'error', message: e.message }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return st;
}

function Note({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'error' }) {
  return (
    <p
      className={`py-6 text-center text-[13px] ${tone === 'error' ? 'text-st-error' : 'text-muted'}`}
      role={tone === 'error' ? 'alert' : undefined}
    >
      {children}
    </p>
  );
}

function TextBody({ text }: { text: string }) {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  const w = String(lines.length).length;
  return (
    <pre className="selectable overflow-auto rounded-[6px] bg-base py-2 font-mono text-[12px] leading-[18px]">
      {lines.map((l, i) => (
        <div key={i} className="flex">
          <span
            className="tnum sticky left-0 shrink-0 select-none bg-base pl-3 pr-3 text-right text-faint"
            style={{ minWidth: `${w + 2.5}ch` }}
            aria-hidden
          >
            {i + 1}
          </span>
          <span className="whitespace-pre pr-4">{l || ' '}</span>
        </div>
      ))}
    </pre>
  );
}

function FileBody({ path }: { path: string }) {
  const st = useLoad<FsFile>(path, () => agent('fs_read', { path }));
  const isMd = /\.(md|markdown|mdx)$/i.test(path);
  const [rendered, setRendered] = useState(true);
  if (st.state === 'loading') return <Note>{t.info.loading}</Note>;
  if (st.state === 'error') return <Note tone="error">{t.files.loadFailed(st.message)}</Note>;
  const f = st.data;
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
        <span className="mono min-w-0 truncate selectable">{homeShort(f.path)}</span>
        <span className="tnum">{formatBytes(f.size)}</span>
        <span>{formatAgo(f.mtime)}</span>
        {isMd && f.kind === 'text' && (
          <div
            className="ml-auto flex rounded-[6px] border border-line-strong p-0.5"
            role="group"
            aria-label={t.files.viewMode}
          >
            {[
              [true, t.files.viewRendered],
              [false, t.files.viewText],
            ].map(([v, label]) => (
              <button
                key={String(v)}
                type="button"
                aria-pressed={rendered === v}
                className={`rounded-[4px] px-2 py-0.5 ${rendered === v ? 'bg-selected font-medium text-fg' : 'hover:text-fg'}`}
                onClick={() => setRendered(v as boolean)}
              >
                {label as string}
              </button>
            ))}
          </div>
        )}
      </div>
      {f.kind === 'image' && (
        <div className="flex justify-center rounded-[6px] bg-base p-4">
          <img
            src={`data:${f.mime};base64,${f.data}`}
            alt={basename(f.path)}
            className="max-h-[60vh] max-w-full object-contain"
          />
        </div>
      )}
      {f.kind === 'binary' && (
        <Note>
          {f.reason === 'too_large'
            ? t.files.imageTooBig(formatBytes(f.size))
            : t.files.binary(formatBytes(f.size))}
        </Note>
      )}
      {f.kind === 'text' &&
        (isMd && rendered ? (
          <div className="md md-doc selectable rounded-[6px] bg-base px-5 py-4 text-[13px] leading-relaxed">
            <ReactMarkdown skipHtml disallowedElements={['img']} unwrapDisallowed>
              {f.text}
            </ReactMarkdown>
          </div>
        ) : (
          <TextBody text={f.text} />
        ))}
      {f.kind === 'text' && f.truncated && (
        <p className="mt-2 text-[12px] text-faint">{t.files.textTruncated}</p>
      )}
    </>
  );
}

function lineCls(l: string): string {
  if (
    l.startsWith('+++') ||
    l.startsWith('---') ||
    l.startsWith('diff ') ||
    l.startsWith('index ') ||
    l.startsWith('new file') ||
    l.startsWith('deleted file') ||
    l.startsWith('similarity') ||
    l.startsWith('rename ')
  )
    return 'text-faint';
  if (l.startsWith('@@')) return 'text-git';
  if (l.startsWith('+')) return 'diff-add';
  if (l.startsWith('-')) return 'diff-del';
  return '';
}

function DiffBody({ v }: { v: Extract<Viewer, { kind: 'diff' }> }) {
  const st = useLoad<MethodResults['git_diff']>(`${v.root}:${v.file}:${v.staged}:${v.untracked}`, () =>
    agent('git_diff', { path: v.root, file: v.file, staged: v.staged, untracked: v.untracked }),
  );
  if (st.state === 'loading') return <Note>{t.info.loading}</Note>;
  if (st.state === 'error') return <Note tone="error">{t.files.loadFailed(st.message)}</Note>;
  const d = st.data;
  if (d.binary) return <Note>{t.gitPanel.diffBinary}</Note>;
  if (!d.diff.trim()) return <Note>{t.gitPanel.diffEmpty}</Note>;
  const lines = d.diff.replace(/\n$/, '').split('\n');
  return (
    <>
      <pre className="selectable overflow-auto rounded-[6px] bg-base py-2 font-mono text-[12px] leading-[18px]">
        {lines.map((l, i) => (
          <div key={i} className={`whitespace-pre px-3 ${lineCls(l)}`}>
            {l || ' '}
          </div>
        ))}
      </pre>
      {d.truncated && <p className="mt-2 text-[12px] text-faint">{t.gitPanel.diffTruncated}</p>}
    </>
  );
}

export function FileViewer() {
  const v = useUi((u) => u.viewer);
  if (!v) return null;
  const close = () => useUi.getState().set({ viewer: null });
  const path = v.kind === 'file' ? v.path : `${v.root}/${v.file}`;
  const where =
    v.kind === 'diff'
      ? v.untracked
        ? t.gitPanel.whereNew
        : v.staged
          ? t.gitPanel.whereStaged
          : t.gitPanel.whereWork
      : '';
  const title = v.kind === 'file' ? basename(v.path) : t.gitPanel.diffTitle(basename(v.file), where);
  return (
    <Modal
      open
      onClose={close}
      title={title}
      width={980}
      footer={
        <>
          {v.kind === 'diff' && (
            <Button small onClick={() => useUi.getState().set({ viewer: { kind: 'file', path } })}>
              <FileText size={14} aria-hidden /> {t.files.open}
            </Button>
          )}
          <Button small onClick={() => openVsCode(path)}>
            <Code size={14} aria-hidden /> {t.files.vscode}
          </Button>
          <Button small onClick={() => void downloadFile(path)}>
            <Download size={14} aria-hidden /> {t.files.download}
          </Button>
          <Button
            small
            variant="primary"
            onClick={() => {
              close();
              pastePathToChat(path);
            }}
          >
            <TextCursorInput size={14} aria-hidden /> {t.files.pastePath}
          </Button>
        </>
      }
    >
      {v.kind === 'file' ? <FileBody path={v.path} key={v.path} /> : <DiffBody v={v} />}
    </Modal>
  );
}
