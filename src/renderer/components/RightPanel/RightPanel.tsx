import {
  Archive,
  Code,
  Copy,
  ExternalLink,
  FileCheck,
  GitBranch,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  SquareTerminal,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
import { ErrorLine, Skeleton, useAgentLoad } from './common';
import { FilesPanel } from './FilesPanel';
import { GitPanel } from './GitPanel';
import { contextFolder } from '../../lib/files';
import { useTabs } from '../../stores/tabs';
import { useUi } from '../../stores/ui';
import { chatMenu } from '../menus';
import { Button } from '../ui/Button';
import { Markdown } from '../ui/Markdown';
import { DropdownMenu } from '../ui/Menu';
import { StatusIcon } from '../ui/StatusIcon';

function Field({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex gap-3 py-[1px] text-[12px] leading-5">
      <span className="w-20 shrink-0 text-muted">{k}</span>
      <span className={`min-w-0 flex-1 break-words selectable ${mono ? 'mono' : ''}`}>{v}</span>
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
      <div className="border-b border-line p-4">
        <div className="mb-2 text-[14px] font-semibold leading-snug selectable">{c.title}</div>
        <Field k={t.info.folder} v={shortPath(c.project, home)} mono />
        {c.branch && <Field k={t.info.branch} v={<span className="text-git">{c.branch}</span>} mono />}
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
                  {t.info.lines} <span className="tnum text-st-idle">+{c.linesAdded}</span>{' '}
                  <span className="tnum text-st-error">−{c.linesRemoved}</span>
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
              <Copy size={11} aria-hidden />
            </button>
          }
        />
        {c.open && (
          <div className="mt-2 flex items-center gap-1.5 text-[12px]">
            <StatusIcon status={claudeUi(c.open.status)} size={12} />
            {c.open.session
              ? t.info.openIn(c.open.session, t.status[claudeUi(c.open.status)] ?? c.open.status)
              : t.info.openOutside}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {st.state === 'loading' && <Skeleton />}
        {st.state === 'error' && <ErrorLine message={st.message} retry={retry} />}
        {st.state === 'ok' &&
          st.data.tail.map((m, i) => (
            <div key={i} className="mb-4">
              <div
                className={`mb-0.5 text-[12px] font-semibold ${m.role === 'user' ? 'text-muted' : 'text-accent-text'}`}
              >
                {m.role === 'user' ? t.info.you : t.info.claude}
              </div>
              <div className="md text-[12px] leading-relaxed selectable">
                <Markdown>{m.text.length > 600 ? m.text.slice(0, 600) + '…' : m.text}</Markdown>
              </div>
            </div>
          ))}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 border-t border-line px-4 py-3">
        {c.archived ? (
          <Button variant="primary" onClick={() => void A.restoreChat(c)}>
            {t.actions.restore}
          </Button>
        ) : (
          <>
            <Button variant="primary" onClick={() => void A.continueChat(c)}>
              <MessageSquare size={14} aria-hidden />
              {c.open ? t.actions.goTo : t.actions.continue}
            </Button>
            <Button onClick={() => void A.archiveChat(c)} disabled={!!c.open}>
              <Archive size={14} aria-hidden />
              {t.actions.archive}
            </Button>
          </>
        )}
        <DropdownMenu
          items={chatMenu(c)}
          trigger={
            <Button variant="ghost" aria-label={t.actions.more} title={t.actions.more}>
              <MoreHorizontal size={16} aria-hidden />
            </Button>
          }
        />
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
        <div className="border-b border-line p-4">
          <div className="mb-2 text-[14px] font-semibold">{project.name}</div>
          <Field k={t.info.folder} v={shortPath(project.path, home)} mono />
          {project.liveSession && (
            <div className="mt-1 flex items-center gap-1.5 text-[12px]">
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
          <div className="space-y-4 p-4 text-[12px]">
            {st.data.git ? (
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <GitBranch size={13} className="text-git" aria-hidden />
                  <span className="mono text-git">{st.data.git.branch}</span>
                  {st.data.git.aheadBehind && (
                    <span className="mono text-muted">[{st.data.git.aheadBehind}]</span>
                  )}
                </div>
                {st.data.git.changes.length > 0 && (
                  <div className="mb-2">
                    <div className="section-title mb-1">{t.info.changes}</div>
                    {st.data.git.changes.slice(0, 20).map((ch, i) => (
                      <div key={i} className="flex gap-2 font-mono text-[11px]">
                        <span className="w-5 shrink-0 text-dirty">{ch.status}</span>
                        <span className="truncate selectable">{ch.file}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="section-title mb-1">{t.info.commits}</div>
                {st.data.git.log.map((l) => (
                  <div key={l.hash} className="flex gap-2">
                    <span className="shrink-0 font-mono text-[11px] text-dirty">{l.hash}</span>
                    <span className="min-w-0 flex-1 truncate">{l.subject}</span>
                    <span className="tnum shrink-0 text-faint">{formatAgo(l.at)}</span>
                  </div>
                ))}
              </div>
            ) : (
              !project.isHome && <div className="text-muted">{t.info.noGit}</div>
            )}
            {st.data.hasClaudeMd && (
              <div className="flex items-center gap-1.5 text-fg">
                <FileCheck size={13} className="text-st-idle" aria-hidden />
                <span className="mono">{t.info.claudeMd}</span>
              </div>
            )}
            {pc.length > 0 && (
              <div>
                <div className="section-title mb-1">{t.info.projectChats}</div>
                {pc.map((c) => (
                  <button
                    key={c.id}
                    className="-mx-1 flex w-[calc(100%+8px)] gap-2 rounded-[4px] px-1 py-0.5 text-left hover:bg-hover"
                    onDoubleClick={() => void A.continueChat(c)}
                    onClick={() => useUi.getState().setSelection({ kind: 'chat', id: c.id })}
                  >
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <span className="tnum shrink-0 text-faint">{formatAgo(c.lastAt)}</span>
                  </button>
                ))}
              </div>
            )}
            {st.data.entries.length > 0 && (
              <div>
                <div className="section-title mb-1">{t.info.entries}</div>
                <div className="mono break-words text-[11px] leading-5 text-muted">
                  {st.data.entries.join('  ')}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 border-t border-line px-4 py-3">
        <Button variant="primary" onClick={() => void A.newChat(project.path)}>
          <Plus size={14} aria-hidden />
          {t.actions.newChat}
        </Button>
        <Button onClick={() => A.openTemp('shell', project.path)}>
          <SquareTerminal size={14} aria-hidden />
          {t.actions.shell}
        </Button>
        <Button onClick={() => A.openTemp('lazygit', project.path)} disabled={!project.git}>
          <GitBranch size={14} aria-hidden />
          {t.actions.lazygit}
        </Button>
        <Button onClick={() => A.openVsCode(project.path)}>
          <Code size={14} aria-hidden />
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
    // the chat grows every few seconds while Claude works; its last prompt and context are refreshed at most every
    // 15 s (a change of status reloads at once)
    Math.floor((liveChat?.lastAt ?? 0) / 15_000),
    s?.attached,
    s?.path,
    s?.windows,
  ]);
  // offline: keep showing the last loaded data (greyed) instead of an error
  const last = useRef<SessionDetails | null>(null);
  if (st.state === 'ok') last.current = st.data;
  const details = st.state === 'ok' ? st.data : !online ? last.current : null;
  if (!s) return <div className="p-4 text-[12px] text-muted">{t.term.ended(name)}</div>;
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
      <div className={`min-h-0 flex-1 overflow-y-auto`} data-session-info>
        <div className="space-y-1 border-b border-line p-4">
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <StatusIcon status={ss.ui} size={12} />
            <span className="font-semibold text-fg">{s.name}</span>
          </div>
          {primary ? (
            <>
              {chat ? (
                <button
                  className="group block w-full text-left text-[15px] font-semibold leading-snug hover:text-accent-text"
                  title={t.info.inChatList}
                  onClick={() => A.showChatInList(chat.id)}
                >
                  {chat.title}
                  <ExternalLink
                    size={12}
                    aria-hidden
                    className="ml-1 inline align-baseline text-faint group-hover:text-accent-text"
                  />
                </button>
              ) : (
                <div className="text-[14px] font-semibold text-muted">{t.info.newChat}</div>
              )}
              <div
                className={`text-[13px] font-medium ${STATUS_COLOR[primary.status] ?? 'text-muted'}`}
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
          <div className="border-b border-line p-4">
            {details ? (
              info?.lastPrompt ? (
                <>
                  <div className="section-title mb-1">
                    {t.info.lastPrompt}
                    {info.lastPrompt.at && (
                      <span
                        className="tnum ml-1 font-normal text-faint"
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
        <div className="p-4">
          {!online && details && <div className="pb-2 text-[12px] text-faint">{t.info.staleOffline}</div>}
          <Field k={t.info.folder} v={shortPath(s.path, home)} mono />
          {git && (
            <Field
              k={t.info.branch}
              v={
                <>
                  <span className="mono text-git">{git.branch}</span>
                  {git.dirty && (
                    <span className="ml-1 text-dirty" title={t.sidebar.dirty}>
                      ✱
                    </span>
                  )}
                  {git.aheadBehind && <span className="mono ml-1 text-muted">[{git.aheadBehind}]</span>}
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
      <div className="flex shrink-0 flex-wrap gap-2 border-t border-line px-4 py-3">
        <Button variant="primary" small onClick={() => A.openSession(s.name)}>
          <SquareTerminal size={14} aria-hidden />
          {t.actions.goTo}
        </Button>
        <Button
          small
          onClick={() => A.renameSession(s.name)}
          aria-label={t.actions.rename}
          title={t.actions.rename}
        >
          <Pencil size={13} aria-hidden />
        </Button>
        <Button variant="danger-soft" small onClick={() => A.killSession(s.name)}>
          <Trash2 size={14} aria-hidden />
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
  let body: React.ReactNode = (
    <div className="p-4 text-[12px] leading-relaxed text-muted">{t.info.nothing}</div>
  );
  if (ctx?.kind === 'chat' && chats[ctx.id]) body = <ChatInfo chat={chats[ctx.id] as Chat} key={ctx.id} />;
  else if (ctx?.kind === 'project') {
    const p = projects.find((x) => x.path === ctx.path);
    if (p) body = <ProjectInfo project={p} key={p.path} />;
  } else if (ctx?.kind === 'session') body = <SessionInfo name={ctx.name} key={ctx.name} />;
  const folder = contextFolder(ctx);
  const noFolder = <div className="p-4 text-[12px] leading-relaxed text-muted">{t.files.noContext}</div>;
  if (rightTab === 'ports') body = <PortsPanel />;
  if (rightTab === 'files') body = folder ? <FilesPanel folder={folder} key={folder} /> : noFolder;
  if (rightTab === 'git') body = folder ? <GitPanel folder={folder} key={folder} /> : noFolder;
  const tabs: { id: 'info' | 'files' | 'git' | 'ports'; label: string }[] = [
    { id: 'info', label: t.info.tabInfo },
    { id: 'files', label: t.info.tabFiles },
    { id: 'git', label: t.info.tabGit },
    { id: 'ports', label: t.ports.tab },
  ];
  return (
    <aside className="flex h-full min-h-0 flex-col bg-surface" data-right-panel>
      <div className="flex h-9 shrink-0 items-end gap-1 border-b border-line px-2" role="tablist">
        {tabs.map((x) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={rightTab === x.id}
            className={`relative flex h-8 items-center gap-1 rounded-t-[6px] px-2.5 text-[12px] transition-colors duration-100 disabled:text-faint ${rightTab === x.id ? 'font-semibold text-fg' : 'text-muted enabled:hover:bg-hover enabled:hover:text-fg'}`}
            onClick={() => useUi.getState().setLayout({ rightTab: x.id })}
          >
            {x.label}
            {rightTab === x.id && (
              <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-t bg-accent" />
            )}
          </button>
        ))}
      </div>
      {body}
    </aside>
  );
}
