import { MessageSquare, Plus, SquareTerminal } from 'lucide-react';
import * as A from '../../actions';
import { t } from '../../i18n/ru';
import { formatAgo } from '../../lib/format';
import { useConn } from '../../stores/conn';
import { useData } from '../../stores/data';
import { useUi } from '../../stores/ui';

export function StartScreen() {
  const chats = useData((d) => d.chats);
  const projects = useData((d) => d.projects);
  const online = useConn((c) => c.state.kind === 'online');
  const recent = Object.values(chats)
    .filter((c) => !c.archived)
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, 5);
  const last = recent[0];
  const name = (p: string | null) =>
    p ? (projects.find((x) => x.path === p)?.name ?? p.split('/').pop()) : '';
  const big =
    'no-drag flex h-14 w-full items-center gap-3 rounded-[8px] border border-line-strong bg-surface px-4 text-left hover:bg-hover disabled:opacity-40';
  return (
    <div className="flex h-full w-full items-center justify-center bg-base" data-testid="start-screen">
      <div className="w-[520px] max-w-[90%]">
        <div className="mb-6 flex items-center gap-2 text-[20px] font-semibold">
          <span className="text-accent">◆</span> ClaudeSpace
        </div>
        <div className="flex flex-col gap-2">
          {last && (
            <button className={big} disabled={!online} onClick={() => void A.continueChat(last)}>
              <MessageSquare size={18} className="text-accent" />
              <span className="min-w-0 flex-1 truncate">{t.start.continueLast(last.title)}</span>
            </button>
          )}
          <button
            className={big}
            disabled={!online}
            onClick={() => useUi.getState().set({ dialog: { kind: 'newChat' } })}
          >
            <Plus size={18} className="text-muted" />
            <span>{t.start.newChat}</span>
          </button>
          <button className={big} disabled={!online} onClick={() => A.openTemp('shell', A.homeDir())}>
            <SquareTerminal size={18} className="text-muted" />
            <span>{t.start.shell}</span>
          </button>
        </div>
        {recent.length > 0 && (
          <div className="mt-6">
            <div className="section-title mb-1 px-1">{t.start.recent}</div>
            {recent.map((c) => (
              <button
                key={c.id}
                className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-hover disabled:opacity-40"
                disabled={!online}
                onClick={() => void A.continueChat(c)}
              >
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                <span className="shrink-0 text-[12px] text-muted">{name(c.project)}</span>
                <span className="tnum w-16 shrink-0 text-right text-[12px] text-muted">
                  {formatAgo(c.lastAt)}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="mt-6 text-center text-[12px] text-faint">{t.start.hint}</div>
      </div>
    </div>
  );
}
