// Files tab (stage 5): the folder of the current chat / project / session as a lazy tree. A file opens in the viewer;
// right click has the rest (paste the path into the chat, download, VS Code). Files dropped from the PC upload into
// the folder under the pointer. Git marks come from git_status: a letter on changed files, ✱ on folders holding them.
import { ChevronRight, Eye, EyeOff, File, Folder, RotateCw, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { FsEntry, GitStatus } from '@shared/protocol';
import { agent, on } from '../../bridge';
import { t } from '../../i18n/ru';
import { basename } from '../../lib/format';
import {
  copyPath,
  downloadFile,
  droppedFiles,
  homeShort,
  pastePathToChat,
  uploadFiles,
} from '../../lib/files';
import { openVsCode } from '../../actions';
import { useConn } from '../../stores/conn';
import { useUi } from '../../stores/ui';
import { ContextMenu } from '../ui/Menu';
import type { MenuEntry } from '../ui/Menu';
import { ErrorLine, Skeleton } from './common';

type Node =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ok'; entries: FsEntry[]; truncated: boolean };

/** letter + colour per git change (colour is never the only signal: the letter and a tooltip carry it) */
const MARK: Record<string, { letter: string; cls: string }> = {
  modified: { letter: 'M', cls: 'text-dirty' },
  renamed: { letter: 'R', cls: 'text-dirty' },
  copied: { letter: 'C', cls: 'text-dirty' },
  added: { letter: 'A', cls: 'text-st-idle' },
  untracked: { letter: 'U', cls: 'text-st-idle' },
  deleted: { letter: 'D', cls: 'text-st-error' },
  conflict: { letter: '!', cls: 'text-st-error' },
};

function useGitMarks(folder: string, reload: number) {
  const [marks, setMarks] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let alive = true;
    agent('git_status', { path: folder }).then(
      (s: GitStatus) => {
        if (!alive) return;
        const m = new Map<string, string>();
        if (s.root)
          for (const f of s.files) {
            const kind = f.conflict
              ? 'conflict'
              : f.untracked
                ? 'untracked'
                : (f.unstaged ?? f.staged ?? 'modified');
            m.set(`${s.root}/${f.path}`, kind);
          }
        setMarks(m);
      },
      () => alive && setMarks(new Map()),
    );
    return () => {
      alive = false;
    };
  }, [folder, reload]);
  return marks;
}

export function FilesPanel({ folder }: { folder: string }) {
  const online = useConn((c) => c.state.kind === 'online');
  const viewer = useUi((u) => u.viewer);
  const [nodes, setNodes] = useState<Record<string, Node>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState(false);
  const [reload, setReload] = useState(0);
  const [dropDir, setDropDir] = useState<string | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadDir = useRef(folder);
  const marks = useGitMarks(folder, reload);

  const load = useCallback((dir: string) => {
    setNodes((n) => ({ ...n, [dir]: n[dir]?.state === 'ok' ? n[dir] : { state: 'loading' } }));
    agent('fs_list', { path: dir }).then(
      (r) => setNodes((n) => ({ ...n, [dir]: { state: 'ok', entries: r.entries, truncated: r.truncated } })),
      (e: Error) => setNodes((n) => ({ ...n, [dir]: { state: 'error', message: e.message } })),
    );
  }, []);

  // a new folder: fresh tree; refresh / Claude finished a turn: reload what is open
  useEffect(() => {
    setNodes({});
    setOpen(new Set());
  }, [folder]);
  useEffect(() => {
    if (!online) return;
    load(folder);
    for (const d of open) load(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, reload, online, load]);
  useEffect(
    () =>
      on('agent.event', ({ event }) => {
        if (event === 'turn_done') setReload((x) => x + 1);
      }),
    [],
  );

  const dirtyDirs = useMemo(() => {
    const s = new Set<string>();
    for (const p of marks.keys()) {
      let d = p.slice(0, p.lastIndexOf('/'));
      while (d.length > folder.length) {
        s.add(d);
        d = d.slice(0, d.lastIndexOf('/'));
      }
    }
    return s;
  }, [marks, folder]);

  const toggle = (dir: string) => {
    const opening = !open.has(dir);
    setOpen((o) => {
      const n = new Set(o);
      if (opening) n.add(dir);
      else n.delete(dir);
      return n;
    });
    if (opening) load(dir);
  };

  const pickUpload = (dir: string) => {
    uploadDir.current = dir;
    uploadInput.current?.click();
  };

  const onDrop = (dir: string) => (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    setDropDir(null);
    const files = droppedFiles(e.dataTransfer);
    if (files.length) void uploadFiles(dir, files).then((n) => n && setReload((x) => x + 1));
  };
  const onDragOver = (dir: string) => (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (dropDir !== dir) setDropDir(dir);
  };

  const fileMenu = (path: string): MenuEntry[] => [
    { label: t.files.open, run: () => useUi.getState().set({ viewer: { kind: 'file', path } }) },
    { label: t.files.pastePath, run: () => pastePathToChat(path) },
    { label: t.files.copyPath, run: () => copyPath(path) },
    'sep',
    { label: t.files.download, run: () => void downloadFile(path) },
    { label: t.files.vscode, run: () => openVsCode(path) },
  ];
  const dirMenu = (path: string): MenuEntry[] => [
    { label: t.files.uploadHere, run: () => pickUpload(path) },
    { label: t.files.pastePath, run: () => pastePathToChat(path) },
    { label: t.files.copyPath, run: () => copyPath(path) },
    'sep',
    { label: t.files.vscode, run: () => openVsCode(path) },
  ];

  const renderDir = (dir: string, depth: number): React.ReactNode => {
    const node = nodes[dir];
    if (!node || node.state === 'loading')
      return depth === 0 ? (
        <Skeleton />
      ) : (
        <div className="h-6 text-[12px] leading-6 text-faint" style={{ paddingLeft: 8 + depth * 14 }}>
          {t.info.loading}
        </div>
      );
    if (node.state === 'error') return <ErrorLine message={node.message} retry={() => load(dir)} />;
    const list = node.entries.filter((e) => hidden || !e.hidden);
    if (!list.length && depth === 0)
      return <p className="px-4 py-3 text-[12px] leading-relaxed text-muted">{t.files.empty}</p>;
    return (
      <>
        {list.map((e) => {
          const path = `${dir}/${e.name}`;
          const isDir = e.type === 'dir';
          const expanded = isDir && open.has(path);
          const mark = marks.get(path);
          const m = mark ? MARK[mark] : undefined;
          const current = viewer?.kind === 'file' && viewer.path === path;
          const row = (
            <button
              type="button"
              aria-expanded={isDir ? expanded : undefined}
              aria-current={current ? 'true' : undefined}
              title={e.link ? `${e.name} (ссылка)` : undefined}
              className={`group flex h-6 w-full min-w-0 items-center gap-1.5 rounded-[4px] pr-2 text-left text-[13px] transition-colors duration-100 hover:bg-hover active:bg-selected ${current ? 'bg-selected' : ''} ${dropDir === path ? 'bg-accent-soft' : ''} ${e.hidden ? 'text-muted' : ''}`}
              style={{ paddingLeft: 6 + depth * 14 }}
              onClick={() =>
                isDir ? toggle(path) : useUi.getState().set({ viewer: { kind: 'file', path } })
              }
              onDragOver={isDir ? onDragOver(path) : undefined}
              onDrop={isDir ? onDrop(path) : undefined}
            >
              {isDir ? (
                <ChevronRight
                  size={13}
                  className={`shrink-0 text-faint transition-transform duration-100 ${expanded ? 'rotate-90' : ''}`}
                  aria-hidden
                />
              ) : (
                <span className="w-[13px] shrink-0" />
              )}
              {isDir ? (
                <Folder size={14} className="shrink-0 text-faint" aria-hidden />
              ) : (
                <File size={14} className="shrink-0 text-faint" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate">{e.name}</span>
              {isDir && dirtyDirs.has(path) && (
                <>
                  <span aria-hidden className="text-dirty" title={t.files.changed}>
                    ✱
                  </span>
                  <span className="sr-only">, {t.files.changed}</span>
                </>
              )}
              {m && (
                <>
                  <span
                    aria-hidden
                    className={`mono w-3 text-center text-[11px] font-semibold ${m.cls}`}
                    title={t.gitPanel.kinds[mark as keyof typeof t.gitPanel.kinds]}
                  >
                    {m.letter}
                  </span>
                  <span className="sr-only">, {t.gitPanel.kinds[mark as keyof typeof t.gitPanel.kinds]}</span>
                </>
              )}
            </button>
          );
          return (
            <div key={e.name} role="none">
              <ContextMenu items={() => (isDir ? dirMenu(path) : fileMenu(path))}>{row}</ContextMenu>
              {expanded && renderDir(path, depth + 1)}
            </div>
          );
        })}
        {node.truncated && (
          <p className="py-1 text-[12px] text-faint" style={{ paddingLeft: 8 + depth * 14 }}>
            {t.files.truncated(node.entries.length)}
          </p>
        )}
      </>
    );
  };

  return (
    <div
      className={`relative flex min-h-0 flex-1 flex-col ${dropDir === folder ? 'outline outline-2 -outline-offset-2 outline-accent' : ''}`}
      onDragOver={onDragOver(folder)}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setDropDir(null);
      }}
      onDrop={onDrop(folder)}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-line py-1.5 pl-4 pr-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">{basename(folder) || folder}</div>
          <div className="mono truncate text-[12px] text-muted selectable">{homeShort(folder)}</div>
        </div>
        <button
          type="button"
          aria-pressed={hidden}
          aria-label={t.files.hidden}
          title={t.files.hiddenTitle}
          className={`rounded-[6px] p-1.5 hover:bg-hover active:bg-selected ${hidden ? 'text-fg' : 'text-muted'}`}
          onClick={() => setHidden((h) => !h)}
        >
          {hidden ? <Eye size={15} aria-hidden /> : <EyeOff size={15} aria-hidden />}
        </button>
        <button
          type="button"
          aria-label={t.files.upload}
          title={t.files.upload}
          disabled={!online}
          className="rounded-[6px] p-1.5 text-muted hover:bg-hover hover:text-fg active:bg-selected disabled:opacity-45"
          onClick={() => pickUpload(folder)}
        >
          <Upload size={15} aria-hidden />
        </button>
        <button
          type="button"
          aria-label={t.files.refresh}
          title={t.files.refresh}
          disabled={!online}
          className="rounded-[6px] p-1.5 text-muted hover:bg-hover hover:text-fg active:bg-selected disabled:opacity-45"
          onClick={() => setReload((x) => x + 1)}
        >
          <RotateCw size={15} aria-hidden />
        </button>
        <input
          ref={uploadInput}
          type="file"
          multiple
          hidden
          aria-hidden
          tabIndex={-1}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length)
              void uploadFiles(uploadDir.current, files).then((n) => n && setReload((x) => x + 1));
          }}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1.5 py-1" data-testid="files-tree">
        {online ? (
          renderDir(folder, 0)
        ) : (
          <ErrorLine message={t.toasts.offlineAction} retry={() => setReload((x) => x + 1)} />
        )}
      </div>
      {dropDir && (
        <div className="pointer-events-none absolute inset-x-2 bottom-2 rounded-[6px] bg-elevated px-3 py-2 text-[12px] shadow-pop">
          {t.files.dropHere(homeShort(dropDir))}
        </div>
      )}
    </div>
  );
}
