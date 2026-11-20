// The list: sessions that are running (the ones waiting for an answer first, they are why you open the app), recent
// chats, and «Новый чат…» at the thumb. Dense rows like the desktop sidebar, but every row is a 56 px target.
import { FolderOpen, MessageSquare, Settings as SettingsIcon, SquareTerminal } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Chat, ConnState, Session } from '@shared/model';
import { StatusIcon } from '../../renderer/components/ui/StatusIcon';
import { basename, formatAgo, shortPath } from '../../renderer/lib/format';
import { claudeUi, primaryClaude, sessionStatus, sortSessions, statusLine } from '../../renderer/lib/status';
import { useConn } from '../../renderer/stores/conn';
import { useData } from '../../renderer/stores/data';
import { continueChat, newChat, openSession, sessionTitle } from '../actions';
import { invoke } from '../bridge';
import { useNow } from '../hooks';
import { m } from '../strings';
import { go, useApp } from '../store';
import { Button, ConnBadge, IconButton, SectionTitle, Sheet, SheetItem } from '../ui';

const CHATS_STEP = 20;
const row =
  'flex min-h-14 w-full items-center gap-3 border-b border-line px-4 py-2 text-left active:bg-selected';

function SessionRow({ s, now }: { s: Session; now: number }) {
  const st = sessionStatus(s);
  const c = primaryClaude(s);
  const title = sessionTitle(s);
  return (
    <button type="button" className={row} onClick={() => openSession(s)} data-testid={`session-${s.name}`}>
      <StatusIcon status={st.ui} size={18} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium">{title}</span>
        <span className="tnum block truncate text-[13px] text-muted">
          {c ? statusLine(c.status, c.statusAt, now) : s.command}
          {' · '}
          {basename(s.path)}
        </span>
      </span>
    </button>
  );
}

function ChatRow({ c, now }: { c: Chat; now: number }) {
  return (
    <button type="button" className={row} onClick={() => void continueChat(c)} data-testid={`chat-${c.id}`}>
      {c.open ? (
        <StatusIcon status={claudeUi(c.open.status)} size={18} />
      ) : (
        <MessageSquare size={18} strokeWidth={1.75} className="shrink-0 text-faint" aria-hidden />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px]">{c.title}</span>
        <span className="tnum block truncate text-[13px] text-muted">
          {c.project ? basename(c.project) : '?'}
          {' · '}
          {formatAgo(c.lastAt, now)}
        </span>
      </span>
    </button>
  );
}

function Banner({ state }: { state: ConnState }) {
  const now = useNow();
  if (state.kind === 'online') return null;
  const text =
    state.kind === 'offline'
      ? m.conn.bannerOffline(Math.max(0, Math.ceil((state.retryAt - now) / 1000)))
      : m.conn.bannerConnecting;
  return (
    <div
      className="flex min-h-12 items-center gap-3 border-b border-line bg-surface px-4 text-[14px]"
      role="status"
    >
      <span className="tnum min-w-0 flex-1 text-muted">{text}</span>
      {state.kind === 'offline' && (
        <Button kind="quiet" className="min-h-11 px-2" onClick={() => void invoke('conn.retryNow')}>
          {m.conn.retryNow}
        </Button>
      )}
    </div>
  );
}

function ProjectSheet() {
  const projects = useData((d) => d.projects);
  const home = useData((d) => d.hello?.home ?? null);
  const sorted = useMemo(() => [...projects].sort((a, b) => b.lastAt - a.lastAt), [projects]);
  return (
    <Sheet title={m.home.pickProject} onClose={() => useApp.getState().set({ sheet: null })}>
      {sorted.length === 0 && <p className="px-4 py-3 text-[15px] text-muted">{m.home.noProjects}</p>}
      {sorted.map((p) => (
        <SheetItem
          key={p.path}
          onClick={() => void newChat(p)}
          hint={<span className="mono">{shortPath(p.path, home)}</span>}
        >
          <span className="flex items-center gap-2">
            <FolderOpen size={16} strokeWidth={1.75} className="shrink-0 text-faint" aria-hidden />
            {p.name}
          </span>
        </SheetItem>
      ))}
    </Sheet>
  );
}

export function Home() {
  const conn = useConn((c) => c.state);
  const sessions = useData((d) => d.sessions);
  const chatMap = useData((d) => d.chats);
  const stale = useData((d) => d.stale);
  const synced = useData((d) => d.sessionsSynced);
  const sheet = useApp((s) => s.sheet);
  const [limit, setLimit] = useState(CHATS_STEP);
  const now = useNow(15_000);

  const sorted = useMemo(() => sortSessions(sessions), [sessions]);
  const chats = useMemo(
    () =>
      Object.values(chatMap)
        .filter((c) => !c.archived)
        .sort((a, b) => b.lastAt - a.lastAt),
    [chatMap],
  );
  const waiting = sessions.filter((s) => sessionStatus(s).raw === 'waiting').length;
  const loading = !synced && sessions.length === 0 && chats.length === 0;

  return (
    <div className="safe flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface pl-4 pr-1">
        <span className="diamond text-[15px]" aria-hidden />
        <h1 className="text-[16px] font-semibold">ClaudeSpace</h1>
        <span className="flex-1" />
        <ConnBadge state={conn} />
        <IconButton label={m.home.settings} onClick={() => go({ kind: 'settings' })}>
          <SettingsIcon size={20} strokeWidth={1.75} aria-hidden />
        </IconButton>
      </header>
      <Banner state={conn} />
      <main className="min-h-0 flex-1 overflow-y-auto pb-4">
        {loading ? (
          <p className="px-4 py-6 text-[15px] text-muted" role="status">
            {m.home.loading}
          </p>
        ) : (
          <>
            {stale && conn.kind !== 'online' && (
              <p className="px-4 pt-3 text-[13px] text-muted">{m.home.stale}</p>
            )}
            <SectionTitle
              aside={
                waiting > 0 && (
                  <span className="tnum rounded-full bg-st-waiting-soft px-2 py-0.5 text-[12px] font-medium text-st-waiting">
                    {m.home.waiting(waiting)}
                  </span>
                )
              }
            >
              {m.home.sessions}
            </SectionTitle>
            {sorted.length === 0 ? (
              <p className="flex items-center gap-2 px-4 py-3 text-[15px] text-muted">
                <SquareTerminal size={16} strokeWidth={1.75} aria-hidden /> {m.home.noSessions}
              </p>
            ) : (
              <div className="border-t border-line">
                {sorted.map((s) => (
                  <SessionRow key={s.name} s={s} now={now} />
                ))}
              </div>
            )}
            <SectionTitle>{m.home.chats}</SectionTitle>
            {chats.length === 0 ? (
              <p className="px-4 py-3 text-[15px] text-muted">{m.home.noChats}</p>
            ) : (
              <div className="border-t border-line">
                {chats.slice(0, limit).map((c) => (
                  <ChatRow key={c.id} c={c} now={now} />
                ))}
              </div>
            )}
            {chats.length > limit && (
              <div className="px-4 pt-3">
                <Button kind="quiet" className="w-full" onClick={() => setLimit((n) => n + CHATS_STEP)}>
                  {m.home.more}
                </Button>
              </div>
            )}
          </>
        )}
      </main>
      <div className="shrink-0 border-t border-line bg-surface px-4 py-3">
        <Button
          kind="primary"
          className="w-full"
          disabled={conn.kind !== 'online'}
          onClick={() => useApp.getState().set({ sheet: 'projects' })}
        >
          {m.home.newChat}
        </Button>
      </div>
      {sheet === 'projects' && <ProjectSheet />}
    </div>
  );
}
