// Git tab (stage 5), read-only: branch and how far it is from its upstream, changed files grouped the way git keeps
// them (conflicts, index, working copy, new), recent commits. A file opens its diff in the viewer; changes are made
// in lazygit or by Claude, which is why the one button here opens lazygit.
import { ArrowDown, ArrowUp, GitBranch, RotateCw, SquareTerminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { GitFile, GitStatus } from '@shared/protocol';
import * as A from '../../actions';
import { agent, on } from '../../bridge';
import { t } from '../../i18n/ru';
import { formatAgo } from '../../lib/format';
import { homeShort } from '../../lib/files';
import { useUi } from '../../stores/ui';
import { Button } from '../ui/Button';
import { ErrorLine, Skeleton, useAgentLoad } from './common';

type Kind = keyof typeof t.gitPanel.kinds;
const MARK: Record<Kind, { letter: string; cls: string }> = {
  modified: { letter: 'M', cls: 'text-dirty' },
  renamed: { letter: 'R', cls: 'text-dirty' },
  copied: { letter: 'C', cls: 'text-dirty' },
  added: { letter: 'A', cls: 'text-st-idle' },
  untracked: { letter: 'U', cls: 'text-st-idle' },
  deleted: { letter: 'D', cls: 'text-st-error' },
  conflict: { letter: '!', cls: 'text-st-error' },
};

interface Row {
  file: GitFile;
  kind: Kind;
  staged: boolean;
}

function FileRow({ root, row, current }: { root: string; row: Row; current: boolean }) {
  const { file, kind, staged } = row;
  const slash = file.path.lastIndexOf('/');
  const name = file.path.slice(slash + 1);
  const dir = slash > 0 ? file.path.slice(0, slash) : '';
  const m = MARK[kind];
  return (
    <button
      type="button"
      aria-current={current ? 'true' : undefined}
      className={`flex h-7 w-full min-w-0 items-center gap-2 rounded-[4px] px-2 text-left text-[13px] transition-colors duration-100 hover:bg-hover active:bg-selected ${current ? 'bg-selected' : ''}`}
      onClick={() =>
        useUi.getState().set({
          viewer: { kind: 'diff', root, file: file.path, staged, untracked: file.untracked },
        })
      }
    >
      <span
        aria-hidden
        className={`mono w-3 shrink-0 text-center text-[11px] font-semibold ${m.cls}`}
        title={t.gitPanel.kinds[kind]}
      >
        {m.letter}
      </span>
      <span className="shrink-0 truncate">{name}</span>
      <span className="sr-only">, {t.gitPanel.kinds[kind]}</span>
      {dir && <span className="mono min-w-0 flex-1 truncate text-[12px] text-faint">{dir}</span>}
    </button>
  );
}

function Group({ title, rows, root }: { title: string; rows: Row[]; root: string }) {
  const viewer = useUi((u) => u.viewer);
  if (!rows.length) return null;
  return (
    <section className="mb-3">
      <h3 className="mb-0.5 flex items-baseline gap-2 px-2 text-[12px] font-semibold text-muted">
        {title}
        <span className="tnum font-normal text-faint">{rows.length}</span>
      </h3>
      {rows.map((r) => (
        <FileRow
          key={`${r.staged}:${r.file.path}`}
          root={root}
          row={r}
          current={viewer?.kind === 'diff' && viewer.file === r.file.path && viewer.staged === r.staged}
        />
      ))}
    </section>
  );
}

function groups(s: Extract<GitStatus, { root: string }>) {
  const conflict: Row[] = [];
  const staged: Row[] = [];
  const unstaged: Row[] = [];
  const untracked: Row[] = [];
  for (const f of s.files) {
    if (f.conflict) conflict.push({ file: f, kind: 'conflict', staged: false });
    else if (f.untracked) untracked.push({ file: f, kind: 'untracked', staged: false });
    else {
      if (f.staged) staged.push({ file: f, kind: f.staged, staged: true });
      if (f.unstaged) unstaged.push({ file: f, kind: f.unstaged, staged: false });
    }
  }
  return { conflict, staged, unstaged, untracked };
}

export function GitPanel({ folder }: { folder: string }) {
  const [tick, setTick] = useState(0);
  const [st, retry] = useAgentLoad(
    folder,
    () => Promise.all([agent('git_status', { path: folder }), agent('git_log', { path: folder, limit: 15 })]),
    [tick],
  );
  // Claude finished a turn: files may have changed
  useEffect(
    () =>
      on('agent.event', ({ event }) => {
        if (event === 'turn_done') setTick((x) => x + 1);
      }),
    [],
  );

  if (st.state === 'loading') return <Skeleton />;
  if (st.state === 'error') return <ErrorLine message={st.message} retry={retry} />;
  const [status, log] = st.data;
  if (!status.root)
    return (
      <p className="p-4 text-[12px] leading-relaxed text-muted">{t.gitPanel.notRepo(homeShort(folder))}</p>
    );
  const root = status.root;
  const g = groups(status);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line py-2 pl-4 pr-2">
        <GitBranch size={14} className="shrink-0 text-git" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="mono truncate text-[13px] font-semibold text-git selectable">
            {status.branch ?? t.gitPanel.detached}
          </div>
          <div className="flex flex-wrap gap-x-3 text-[12px] text-muted">
            {status.upstream ? (
              <>
                <span className="mono truncate selectable">{status.upstream}</span>
                {status.ahead > 0 && (
                  <span className="tnum flex items-center gap-0.5">
                    <ArrowUp size={11} aria-hidden />
                    {t.gitPanel.ahead(status.ahead)}
                  </span>
                )}
                {status.behind > 0 && (
                  <span className="tnum flex items-center gap-0.5">
                    <ArrowDown size={11} aria-hidden />
                    {t.gitPanel.behind(status.behind)}
                  </span>
                )}
              </>
            ) : (
              <span>{t.gitPanel.noUpstream}</span>
            )}
          </div>
        </div>
        <button
          type="button"
          aria-label={t.files.refresh}
          title={t.files.refresh}
          className="rounded-[6px] p-1.5 text-muted hover:bg-hover hover:text-fg active:bg-selected"
          onClick={() => setTick((x) => x + 1)}
        >
          <RotateCw size={15} aria-hidden />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
        {status.files.length === 0 ? (
          <p className="px-2 pb-3 text-[12px] text-muted">{t.gitPanel.clean}</p>
        ) : (
          <>
            <Group title={t.gitPanel.conflict} rows={g.conflict} root={root} />
            <Group title={t.gitPanel.staged} rows={g.staged} root={root} />
            <Group title={t.gitPanel.unstaged} rows={g.unstaged} root={root} />
            <Group title={t.gitPanel.untracked} rows={g.untracked} root={root} />
            {status.truncated && <p className="px-2 pb-3 text-[12px] text-faint">{t.gitPanel.truncated}</p>}
          </>
        )}

        <section className="mt-1 border-t border-line pt-3">
          <h3 className="mb-1 px-2 text-[12px] font-semibold text-muted">{t.gitPanel.commits}</h3>
          {log.commits.length === 0 ? (
            <p className="px-2 text-[12px] text-muted">{t.gitPanel.noCommits}</p>
          ) : (
            <ol className="selectable">
              {log.commits.map((c) => (
                <li key={c.hash} className="flex min-w-0 items-baseline gap-2 px-2 py-[3px] text-[12px]">
                  <span className="mono shrink-0 text-faint">{c.short}</span>
                  <span className="min-w-0 flex-1 truncate" title={`${c.subject}\n${c.author}`}>
                    {c.subject}
                  </span>
                  <span className="tnum shrink-0 text-faint">{formatAgo(c.at)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <div className="shrink-0 space-y-2 border-t border-line p-3">
        <Button small onClick={() => A.openTemp('lazygit', root)}>
          <SquareTerminal size={14} aria-hidden /> {t.gitPanel.lazygit}
        </Button>
        <p className="text-[12px] leading-relaxed text-faint">{t.gitPanel.lazygitHint}</p>
      </div>
    </div>
  );
}
