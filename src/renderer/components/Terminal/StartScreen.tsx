// Start screen (no tabs). One focal point: the last chat to continue (or, when Claude is waiting somewhere, the
// session that needs you). Spacious on purpose: the rhythm break of RHYTHM 2 (DESIGN §5.4). Offline it says so
// instead of showing dead buttons (R-27).
import { MessageCircleQuestion, MessageSquare, Plus, SquareTerminal, WifiOff } from 'lucide-react';
import * as A from '../../actions';
import { invoke } from '../../bridge';
import { t } from '../../i18n/ru';
import { formatAgo } from '../../lib/format';
import { sessionStatus, sortSessions } from '../../lib/status';
import { useConn } from '../../stores/conn';
import { useData } from '../../stores/data';
import { useUi } from '../../stores/ui';
import { Button, Kbd } from '../ui/Button';

export function StartScreen() {
  const chats = useData((d) => d.chats);
  const projects = useData((d) => d.projects);
  const sessions = useData((d) => d.sessions);
  const conn = useConn((c) => c.state);
  const online = conn.kind === 'online';
  const recent = Object.values(chats)
    .filter((c) => !c.archived)
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, 6);
  const last = recent[0];
  const waiting = sortSessions(sessions).filter((s) => sessionStatus(s).ui === 'waiting');
  const name = (p: string | null) =>
    p ? (projects.find((x) => x.path === p)?.name ?? p.split('/').pop()) : '';
  const card =
    'no-drag group flex w-full items-center gap-3 rounded-[10px] border text-left transition-colors duration-100 disabled:opacity-45';
  return (
    <div
      className="flex h-full w-full items-center justify-center overflow-auto bg-base px-6 py-8"
      data-testid="start-screen"
    >
      <div className="w-[560px] max-w-full">
        <div className="mb-8 flex items-center gap-3">
          <span className="diamond text-[22px]" aria-hidden />
          <h1 className="text-[22px] font-semibold tracking-[-0.01em]">
            {online ? t.start.title : t.start.offlineTitle}
          </h1>
        </div>

        {!online && (
          <div className="mb-6 flex items-start gap-3 rounded-[10px] border border-line-strong bg-surface p-4 text-[13px]">
            <WifiOff size={16} className="mt-0.5 shrink-0 text-st-error" aria-hidden />
            <div className="min-w-0 flex-1 text-muted">{t.start.offlineBody}</div>
            <Button small onClick={() => void invoke('conn.retryNow')}>
              {t.conn.now}
            </Button>
          </div>
        )}

        {online && waiting.length > 0 && (
          <button
            className={`${card} mb-3 border-st-waiting/50 bg-st-waiting-soft px-4 py-3 hover:border-st-waiting`}
            onClick={() => A.openSession((waiting[0] as (typeof waiting)[number]).name)}
          >
            <MessageCircleQuestion size={18} className="shrink-0 text-st-waiting" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{t.start.waiting(waiting.length)}</span>
              <span className="block truncate text-[12px] text-muted">
                {waiting.map((s) => s.name).join(', ')}
              </span>
            </span>
            <span className="shrink-0 text-[12px] font-medium text-fg">{t.actions.goTo}</span>
          </button>
        )}

        {last ? (
          <button
            className={`${card} border-line-strong bg-surface px-4 py-4 hover:border-accent/70 hover:bg-hover`}
            disabled={!online}
            onClick={() => void A.continueChat(last)}
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-accent text-accent-fg">
              <MessageSquare size={18} aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] text-muted">
                {t.start.continueLabel} · {name(last.project)} · {formatAgo(last.lastAt)}
              </span>
              <span className="block truncate text-[15px] font-semibold">
                {t.start.continueLast(last.title)}
              </span>
            </span>
          </button>
        ) : (
          <div className="rounded-[10px] border border-dashed border-line-strong px-4 py-4 text-[13px] text-muted">
            {t.start.empty}
          </div>
        )}

        <div className="mt-3 grid grid-cols-2 gap-3">
          <button
            className={`${card} border-line bg-transparent px-3 py-2.5 hover:border-line-strong hover:bg-surface`}
            disabled={!online}
            onClick={() => useUi.getState().set({ dialog: { kind: 'newChat' } })}
          >
            <Plus size={16} className="shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{t.start.newChat}</span>
            <Kbd>Ctrl+Shift+T</Kbd>
          </button>
          <button
            className={`${card} border-line bg-transparent px-3 py-2.5 hover:border-line-strong hover:bg-surface`}
            disabled={!online}
            onClick={() => A.openTemp('shell', A.homeDir())}
          >
            <SquareTerminal size={16} className="shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{t.start.shell}</span>
          </button>
        </div>

        {recent.length > 1 && (
          <div className="mt-10">
            <h2 className="section-title mb-2 px-2">{t.start.recent}</h2>
            {recent.slice(1).map((c) => (
              <button
                key={c.id}
                className="flex h-8 w-full items-center gap-3 rounded-[6px] px-2 text-left hover:bg-surface active:bg-hover disabled:opacity-45"
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
        <div className="mt-10 flex items-center justify-center gap-2 text-[12px] text-faint">
          <Kbd>Ctrl K</Kbd>
          <span>{t.start.hint}</span>
        </div>
      </div>
    </div>
  );
}
