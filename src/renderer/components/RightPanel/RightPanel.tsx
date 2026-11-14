import {
  Archive,
  Code,
  Copy,
  ExternalLink,
  GitBranch,
  MessageSquare,
  Plus,
  SquareTerminal,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Chat, ChatMessage, GitDetails, Project, Selection, SessionDetails } from '@shared/model';
import * as A from '../../actions';
import { agent } from '../../bridge';
import { t } from '../../i18n/ru';
import {
  formatAgo,
  formatBytes,
  formatClock,
  formatDuration,
  formatModel,
  formatTokens,
  formatUptime,
  formatWhen,
  plural,
  shortPath,
} from '../../lib/format';
import { claudeUi, primaryClaude, sessionStatus, statusLine } from '../../lib/status';
import { useConn } from '../../stores/conn';
import { useData } from '../../stores/data';
import { PortsPanel } from './PortsPanel';
import { useTabs } from '../../stores/tabs';
import { useUi } from '../../stores/ui';
import { chatMenu } from '../menus';
import { Button } from '../ui/Button';
import { DropdownMenu } from '../ui/Menu';
import { StatusIcon } from '../ui/StatusIcon';

type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; data: T };

function useAgentLoad<T>(key: string | null, fn: () => Promise<T>, deps: unknown[]): [Load<T>, () => void] {
  const [st, setSt] = useState<Load<T>>({ state: 'loading' });
  const [n, setN] = useState(0);
  const online = useConn((c) => c.state.kind === 'online');
  useEffect(() => {
    if (!key) return;
    let alive = true;
    if (!online) {
      setSt({ state: 'error', message: t.toasts.offlineAction });
      return;
    }
    setSt((s) => (s.state === 'ok' ? s : { state: 'loading' }));
    fn().then(
      (data) => alive && setSt({ state: 'ok', data }),
      (e: Error) => alive && setSt({ state: 'error', message: e.message }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, n, online, ...deps]);
  return [st, () => setN((x) => x + 1)];
}

function Field({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-[12px]">
      <span className="w-20 shrink-0 text-muted">{k}</span>
      <span className="min-w-0 flex-1 break-words selectable">{v}</span>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2 p-3" aria-label={t.info.loading}>
      {[80, 60, 70, 40].map((w, i) => (
        <div key={i} className="h-3 animate-pulse rounded bg-hover" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

function ErrorLine({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="p-3 text-[12px]">
      <span className="text-st-error">{t.info.failed(message)}</span>{' '}
      <button className="text-accent hover:underline" onClick={retry}>
        {t.actions.retry}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- chat
function ChatInfo({ chat }: { chat: Chat }) {
  const home = useData((d) => d.hello?.home ?? null);
  const [st, retry] = useAgentLoad<{ chat: Chat; tail: ChatMessage[] }>(
    chat.id,
    () => agent('chat_preview', { chatId: chat.id, messages: 6 }),
    [chat.lastAt],
  );
  const c = chat;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1 border-b border-line p-3">
        <div className="mb-1 text-[14px] font-semibold leading-snug selectable">{c.title}</div>
        <Field k={t.info.folder} v={shortPath(c.project, home)} />
        {c.branch && <Field k={t.info.branch} v={<span className="text-git">{c.branch}</span>} />}
        <Field k={t.info.started} v={formatWhen(c.firstAt)} />
        <Field k={t.info.last} v={`${formatWhen(c.lastAt)} (${formatAgo(c.lastAt)})`} />
        <Field
          k={t.info.prompts}
          v={
            <>
              {c.prompts}
              {c.promptsApprox ? '+' : ''}
              {c.linesAdded != null && (
                <span className="ml-2 text-muted">
                  {t.info.lines} <span className="text-st-idle">+{c.linesAdded}</span>{' '}
                  <span className="text-st-error">−{c.linesRemoved}</span>
                </span>
              )}
            </>
          }
        />
        <Field k={t.info.size} v={formatBytes(c.sizeBytes)} />
        <Field
          k="id"
          v={
            <button
              className="inline-flex items-center gap-1 text-muted hover:text-fg"
              onClick={() => A.copyText(c.id)}
              title={t.actions.copyId}
            >
              <span className="truncate font-mono text-[11px]">{c.id}</span>
              <Copy size={11} />
            </button>
          }
        />
        {c.open && (
          <div className="flex items-center gap-1.5 pt-1 text-[12px]">
            <StatusIcon status={claudeUi(c.open.status)} size={12} />
            {c.open.session
              ? t.info.openIn(c.open.session, t.status[claudeUi(c.open.status)] ?? c.open.status)
              : t.info.openOutside}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {st.state === 'loading' && <Skeleton />}
        {st.state === 'error' && <ErrorLine message={st.message} retry={retry} />}
        {st.state === 'ok' &&
          st.data.tail.map((m, i) => (
            <div key={i} className="mb-3">
              <div
                className={`mb-0.5 text-[11px] font-semibold ${m.role === 'user' ? 'text-git' : 'text-accent'}`}
              >
                {m.role === 'user' ? t.info.you : t.info.claude}
              </div>
              <div className="md text-[12px] leading-relaxed selectable">
                <ReactMarkdown skipHtml disallowedElements={['img']} unwrapDisallowed>
                  {m.text.length > 600 ? m.text.slice(0, 600) + '…' : m.text}
                </ReactMarkdown>
              </div>
            </div>
          ))}
      </div>
      <div className="flex shrink-0 gap-2 border-t border-line p-3">
        {c.archived ? (
          <Button variant="primary" onClick={() => void A.restoreChat(c)}>
            {t.actions.restore}
          </Button>
        ) : (
          <>
            <Button variant="primary" onClick={() => void A.continueChat(c)}>
              <MessageSquare size={14} />
              {c.open ? t.actions.goTo : t.actions.continue}
            </Button>
            <Button onClick={() => void A.archiveChat(c)} disabled={!!c.open}>
              <Archive size={14} />
              {t.actions.archive}
            </Button>
          </>
        )}
        <DropdownMenu items={chatMenu(c)} trigger={<Button aria-label="Ещё">⋯</Button>} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- project
function ProjectInfo({ project }: { project: Project }) {
  const home = useData((d) => d.hello?.home ?? null);
  const chats = useData((d) => d.chats);
  const [st, retry] = useAgentLoad<{
    project: Project;
    git: GitDetails | null;
    hasClaudeMd: boolean;
    entries: string[];
  }>(project.path, () => agent('project_preview', { path: project.path }), [
    project.lastAt,
    project.git?.dirty,
    project.git?.branch,
  ]);
  const pc = Object.values(chats)
    .filter((c) => !c.archived && c.project === project.path)
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, 5);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-1 border-b border-line p-3">
          <div className="text-[14px] font-semibold">{project.name}</div>
          <Field k={t.info.folder} v={shortPath(project.path, home)} />
          {project.liveSession && (
            <div className="flex items-center gap-1.5 text-[12px]">
              <StatusIcon status={claudeUi(project.liveStatus)} size={12} />
              <button
                className="hover:underline"
                onClick={() => A.openSession(project.liveSession as string)}
              >
                {project.liveSession}
              </button>
            </div>
          )}
        </div>
        {st.state === 'loading' && <Skeleton />}
        {st.state === 'error' && <ErrorLine message={st.message} retry={retry} />}
        {st.state === 'ok' && (
          <div className="space-y-3 p-3 text-[12px]">
            {st.data.git ? (
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <GitBranch size={13} className="text-git" />
                  <span className="text-git">{st.data.git.branch}</span>
                  {st.data.git.aheadBehind && <span className="text-muted">[{st.data.git.aheadBehind}]</span>}
                </div>
                {st.data.git.changes.length > 0 && (
                  <div className="mb-2">
                    <div className="section-title mb-0.5">{t.info.changes}</div>
                    {st.data.git.changes.slice(0, 20).map((ch, i) => (
                      <div key={i} className="flex gap-2 font-mono text-[11px]">
                        <span className="w-5 shrink-0 text-dirty">{ch.status}</span>
                        <span className="truncate selectable">{ch.file}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="section-title mb-0.5">{t.info.commits}</div>
                {st.data.git.log.map((l) => (
                  <div key={l.hash} className="flex gap-2">
                    <span className="shrink-0 font-mono text-[11px] text-dirty">{l.hash}</span>
                    <span className="min-w-0 flex-1 truncate">{l.subject}</span>
                    <span className="shrink-0 text-faint">{formatAgo(l.at)}</span>
                  </div>
                ))}
              </div>
            ) : (
              !project.isHome && <div className="text-muted">{t.info.noGit}</div>
            )}
            {st.data.hasClaudeMd && <div className="text-st-idle">{t.info.claudeMd}</div>}
            {pc.length > 0 && (
              <div>
                <div className="section-title mb-0.5">{t.info.projectChats}</div>
                {pc.map((c) => (
                  <button
                    key={c.id}
                    className="flex w-full gap-2 rounded px-1 py-0.5 text-left hover:bg-hover"
                    onDoubleClick={() => void A.continueChat(c)}
                    onClick={() => useUi.getState().setSelection({ kind: 'chat', id: c.id })}
                  >
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <span className="shrink-0 text-faint">{formatAgo(c.lastAt)}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="break-words text-faint">{st.data.entries.join('  ')}</div>
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 border-t border-line p-3">
        <Button variant="primary" onClick={() => void A.newChat(project.path)}>
          <Plus size={14} />
          {t.actions.newChat}
        </Button>
        <Button onClick={() => A.openTemp('shell', project.path)}>
          <SquareTerminal size={14} />
          Shell
        </Button>
        <Button onClick={() => A.openTemp('lazygit', project.path)} disabled={!project.git}>
          <GitBranch size={14} />
          lazygit
        </Button>
        <Button onClick={() => A.openVsCode(project.path)}>
          <Code size={14} />
          VS Code
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- session
/** re-render every `ms` so durations («думает 2 мин») stay current */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const STATUS_COLOR: Record<string, string> = {
  busy: 'text-st-busy',
  waiting: 'text-st-waiting',
  idle: 'text-muted',
};

function sinceText(ms: number, now: number): string {
  return ms >= now - 86_400_000 ? formatDuration(now - ms) : formatUptime(Math.round((now - ms) / 1000));
}

function clientsText(n: number, here: boolean): string {
  if (n <= 0) return t.info.nobody;
  if (here) return n === 1 ? t.info.onlyHere : t.info.hereAndMore(n - 1);
  return `${n} ${plural(n, t.info.clientForms)}`;
}

function SessionInfo({ name }: { name: string }) {
  const s = useData((d) => d.sessions.find((x) => x.name === name));
  const home = useData((d) => d.hello?.home ?? null);
  const online = useConn((c) => c.state.kind === 'online');
  const here = useTabs((x) =>
    x.tabs.some((tb) => tb.kind === 'tmux' && tb.session === name && tb.term === 'live'),
  );
  const now = useNow(15_000);
  const primary = s ? primaryClaude(s) : null;
  const liveChat = useData((d) => (primary ? d.chats[primary.chatId] : undefined));
  const [st, retry] = useAgentLoad<SessionDetails>(name, () => agent('session_preview', { session: name }), [
    primary?.chatId,
    primary?.status,
    primary?.statusAt,
    liveChat?.lastAt,
    s?.attached,
    s?.path,
    s?.windows,
  ]);
  // offline: keep showing the last loaded data (greyed) instead of an error
  const last = useRef<SessionDetails | null>(null);
  if (st.state === 'ok') last.current = st.data;
  const details = st.state === 'ok' ? st.data : !online ? last.current : null;
  if (!s) return <div className="p-3 text-[12px] text-muted">{t.term.ended(name)}</div>;
  const ss = sessionStatus(s);
  const info = primary ? details?.claude.find((c) => c.chatId === primary.chatId) : undefined;
  const chat = liveChat ?? info?.chat ?? null;
  const git = details?.git ?? null;
  const nClients = details && online ? details.clients.length : s.attached;
  const clientsHint = (details?.clients ?? [])
    .map((c) => `${c.tty} · ${c.term} · ${c.size} · ${formatAgo(c.activity, now)}`)
    .join('\n');
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`min-h-0 flex-1 overflow-y-auto ${!online ? 'opacity-60' : ''}`} data-session-info>
        <div className="space-y-1 border-b border-line p-3">
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <StatusIcon status={ss.ui} size={12} />
            <span className="font-semibold text-fg">{s.name}</span>
          </div>
          {primary ? (
            <>
              {chat ? (
                <button
                  className="group block w-full text-left text-[14px] font-semibold leading-snug hover:text-accent"
                  title={t.info.inChatList}
                  onClick={() => A.showChatInList(chat.id)}
                >
                  {chat.title}
                  <ExternalLink
                    size={12}
                    className="ml-1 inline align-baseline text-faint group-hover:text-accent"
                  />
                </button>
              ) : (
                <div className="text-[14px] font-semibold text-muted">{t.info.newChat}</div>
              )}
              <div
                className={`text-[12px] ${STATUS_COLOR[primary.status] ?? 'text-muted'}`}
                title={primary.statusAt ? formatWhen(primary.statusAt) : undefined}
              >
                {statusLine(primary.status, primary.statusAt, now)}
              </div>
              {s.claude.length > 1 && (
                <div className="text-[11px] text-faint">{t.info.moreClaude(s.claude.length - 1)}</div>
              )}
            </>
          ) : (
            <div className="text-[12px] text-muted">{t.info.noClaude(s.command)}</div>
          )}
        </div>
        {primary && (
          <div className="border-b border-line p-3">
            {details ? (
              info?.lastPrompt ? (
                <>
                  <div className="section-title mb-0.5">
                    {t.info.lastPrompt}
                    {info.lastPrompt.at && (
                      <span
                        className="ml-1 font-normal normal-case tracking-normal text-faint"
                        title={formatWhen(info.lastPrompt.at)}
                      >
                        · {formatClock(info.lastPrompt.at, now)}
                        {now - info.lastPrompt.at < 86_400_000 && ` (${formatAgo(info.lastPrompt.at, now)})`}
                      </span>
                    )}
                  </div>
                  <div
                    className="line-clamp-3 whitespace-pre-line break-words text-[12px] leading-relaxed selectable"
                    title={info.lastPrompt.text}
                    data-last-prompt
                  >
                    {info.lastPrompt.text}
                  </div>
                </>
              ) : (
                <div className="text-[12px] text-muted">{t.info.noPrompt}</div>
              )
            ) : st.state === 'error' ? (
              <ErrorLine message={st.message} retry={retry} />
            ) : (
              <Skeleton />
            )}
          </div>
        )}
        <div className="space-y-1 p-3">
          {!online && details && <div className="pb-1 text-[11px] text-faint">{t.info.staleOffline}</div>}
          <Field k={t.info.folder} v={shortPath(s.path, home)} />
          {git && (
            <Field
              k={t.info.branch}
              v={
                <>
                  <span className="text-git">{git.branch}</span>
                  {git.dirty && <span className="ml-1 text-dirty">✱</span>}
                  {git.aheadBehind && <span className="ml-1 text-muted">[{git.aheadBehind}]</span>}
                </>
              }
            />
          )}
          {info?.model && (
            <Field
              k={t.info.model}
              v={
                <>
                  <span title={info.model}>{formatModel(info.model)}</span>
                  {info.context && (
                    <span
                      className="ml-2 text-muted"
                      title={t.info.contextHint(info.context.tokens, info.context.output)}
                    >
                      {t.info.context(formatTokens(info.context.tokens))}
                    </span>
                  )}
                </>
              }
            />
          )}
          <Field
            k={t.info.clients}
            v={<span title={clientsHint || undefined}>{clientsText(nClients, here)}</span>}
          />
          <Field
            k={t.info.session}
            v={
              <>
                {details?.created ? t.info.uptime(sinceText(details.created, now)) : null}
                <span className="text-muted">
                  {details?.created ? ' · ' : ''}
                  {s.windows} {plural(s.windows, t.info.windowForms)}
                </span>
              </>
            }
          />
          {!primary && st.state === 'error' && <ErrorLine message={st.message} retry={retry} />}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 border-t border-line p-3">
        <Button variant="primary" small onClick={() => A.openSession(s.name)}>
          <SquareTerminal size={14} />
          {t.actions.goTo}
        </Button>
        <Button small onClick={() => A.renameSession(s.name)}>
          {t.actions.rename}
        </Button>
        <Button variant="danger" small onClick={() => A.killSession(s.name)}>
          {t.actions.killSession}
        </Button>
      </div>
    </div>
  );
}

export function currentContext(selection: Selection): Selection {
  if (selection) return selection;
  const { tabs, activeId } = useTabs.getState();
  const tab = tabs.find((x) => x.id === activeId);
  if (tab?.kind === 'tmux' && tab.session) return { kind: 'session', name: tab.session };
  return null;
}

export function RightPanel() {
  const selection = useUi((u) => u.selection);
  const rightTab = useUi((u) => u.layout.rightTab);
  useTabs((s) => s.activeId);
  const chats = useData((d) => d.chats);
  const projects = useData((d) => d.projects);
  const ctx = currentContext(selection);
  let body: React.ReactNode = <div className="p-4 text-[12px] text-muted">{t.info.nothing}</div>;
  if (ctx?.kind === 'chat' && chats[ctx.id]) body = <ChatInfo chat={chats[ctx.id] as Chat} key={ctx.id} />;
  else if (ctx?.kind === 'project') {
    const p = projects.find((x) => x.path === ctx.path);
    if (p) body = <ProjectInfo project={p} key={p.path} />;
  } else if (ctx?.kind === 'session') body = <SessionInfo name={ctx.name} key={ctx.name} />;
  if (rightTab === 'ports') body = <PortsPanel />;
  const tabs: { id: 'info' | 'files' | 'git' | 'ports'; label: string; disabled?: boolean }[] = [
    { id: 'info', label: t.info.tabInfo },
    { id: 'ports', label: t.ports.tab },
    { id: 'files', label: t.info.tabFiles, disabled: true },
    { id: 'git', label: t.info.tabGit, disabled: true },
  ];
  return (
    <aside className="flex h-full min-h-0 flex-col bg-surface" data-right-panel>
      <div className="flex h-8 shrink-0 items-end gap-1 border-b border-line px-2">
        {tabs.map((x) => (
          <button
            key={x.id}
            disabled={x.disabled}
            title={x.disabled ? t.info.soon : undefined}
            className={`h-7 rounded-t px-2 text-[12px] disabled:opacity-40 ${rightTab === x.id ? 'border-b-2 border-accent text-fg' : 'text-muted hover:text-fg'}`}
            onClick={() => useUi.getState().setLayout({ rightTab: x.id })}
          >
            {x.label}
          </button>
        ))}
      </div>
      {body}
    </aside>
  );
}
