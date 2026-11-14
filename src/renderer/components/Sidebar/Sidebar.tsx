import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, MoreHorizontal, Plus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { Chat, Session } from '@shared/model';
import * as A from '../../actions';
import { t } from '../../i18n/ru';
import { dayGroup, formatAgo, matches, shortPath } from '../../lib/format';
import type { DayGroup } from '../../lib/format';
import { claudeUi, isUnknownStatus, sessionStatus, sortSessions } from '../../lib/status';
import { useConn } from '../../stores/conn';
import { useData } from '../../stores/data';
import { useTabs } from '../../stores/tabs';
import { useUi } from '../../stores/ui';
import { chatMenu, projectMenu, sessionMenu } from '../menus';
import { Button } from '../ui/Button';
import { ContextMenu, DropdownMenu } from '../ui/Menu';
import { StatusIcon } from '../ui/StatusIcon';

const sel = () => useUi.getState();

function Row({
  selected,
  accentBar,
  onSelect,
  onOpen,
  menu,
  height,
  children,
  title,
  testid,
}: {
  selected: boolean;
  accentBar?: boolean;
  onSelect: () => void;
  onOpen: () => void;
  menu: Parameters<typeof ContextMenu>[0]['items'];
  height: number;
  children: ReactNode;
  title?: string;
  testid?: string;
}) {
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpen();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const all = Array.from(document.querySelectorAll<HTMLElement>('[data-row]'));
      const i = all.indexOf(e.currentTarget as HTMLElement);
      all[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
    }
  };
  return (
    <ContextMenu items={menu}>
      <div
        data-row
        data-testid={testid}
        tabIndex={0}
        title={title}
        onClick={onSelect}
        onFocus={onSelect}
        onDoubleClick={onOpen}
        onKeyDown={onKey}
        className={`group relative flex cursor-default items-center gap-2 rounded-[4px] px-2 outline-none ${selected ? 'bg-selected' : 'hover:bg-hover has-[[data-state=open]]:bg-hover'}`}
        style={{ height }}
      >
        {accentBar && <span className="absolute inset-y-1 left-0 w-[2px] rounded bg-accent" />}
        {children}
        <DropdownMenu
          items={typeof menu === 'function' ? menu() : menu}
          align="end"
          trigger={
            <button
              aria-label="Действия"
              className="hidden shrink-0 rounded p-0.5 text-muted hover:bg-selected group-hover:block data-[state=open]:block data-[state=open]:bg-selected"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal size={14} />
            </button>
          }
        />
      </div>
    </ContextMenu>
  );
}

function useRowHeights() {
  const density = useUi((u) => u.settings?.appearance.density ?? 'compact');
  const add = density === 'normal' ? 4 : 0;
  return { row: 28 + add, chat: 40 + add, nested: 24 + add };
}

// ---------------------------------------------------------------- Активные
function ActiveSection() {
  const sessions = useData((d) => d.sessions);
  const stale = useData((d) => d.stale);
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const selection = useUi((u) => u.selection);
  const expanded = useUi((u) => u.activeExpanded);
  const collapsed = useUi((u) => u.activeCollapsed);
  const online = useConn((c) => c.state.kind === 'online');
  const H = useRowHeights();
  const sorted = sortSessions(sessions);
  const activeTabSession = tabs.find((x) => x.id === activeId)?.session;
  const openSessions = new Set(tabs.filter((x) => x.kind === 'tmux').map((x) => x.session));
  const shown = expanded ? sorted : sorted.slice(0, 5);
  return (
    <section
      className={`shrink-0 border-b border-line px-1.5 pb-1.5 ${stale ? 'opacity-60' : ''}`}
      data-section="active"
    >
      <button
        className="flex h-7 w-full items-center gap-1 px-1.5"
        onClick={() => sel().set({ activeCollapsed: !collapsed })}
      >
        {collapsed ? (
          <ChevronRight size={12} className="text-muted" />
        ) : (
          <ChevronDown size={12} className="text-muted" />
        )}
        <span className="section-title flex-1 text-left">{t.sidebar.active}</span>
        <span className="tnum text-[11px] text-muted">{sessions.length}</span>
      </button>
      {!collapsed && (
        <div>
          {sorted.length === 0 && (
            <div className="flex items-center justify-between px-2 py-1 text-[12px] text-muted">
              {t.sidebar.noSessions}
              <Button small onClick={() => sel().set({ dialog: { kind: 'newChat' } })} disabled={!online}>
                {t.actions.newChat}
              </Button>
            </div>
          )}
          {shown.map((s) => (
            <SessionRow
              key={s.name}
              s={s}
              height={H.row}
              selected={selection?.kind === 'session' && selection.name === s.name}
              open={openSessions.has(s.name)}
              current={activeTabSession === s.name}
            />
          ))}
          {sorted.length > 5 && (
            <button
              className="px-2 text-[12px] text-muted hover:text-fg"
              onClick={() => sel().set({ activeExpanded: !expanded })}
            >
              {expanded ? t.sidebar.less : t.sidebar.more(sorted.length - 5)}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function SessionRow({
  s,
  height,
  selected,
  open,
  current,
}: {
  s: Session;
  height: number;
  selected: boolean;
  open: boolean;
  current: boolean;
}) {
  const st = sessionStatus(s);
  const word = s.claude.length
    ? isUnknownStatus(st.raw)
      ? (st.raw ?? '')
      : t.status[st.ui]
    : s.command || '?';
  const tip = [
    shortPath(s.path, useData.getState().hello?.home ?? null),
    t.sidebar.clients(s.attached),
    `активность ${formatAgo(s.activity)}`,
  ].join('\n');
  return (
    <Row
      testid={`session-${s.name}`}
      selected={selected}
      accentBar={open || current}
      height={height}
      title={tip}
      onSelect={() => sel().setSelection({ kind: 'session', name: s.name })}
      onOpen={() => A.openSession(s.name)}
      menu={() => sessionMenu(s)}
    >
      <StatusIcon status={st.ui} unknown={isUnknownStatus(st.raw)} />
      <span className="min-w-0 flex-1 truncate">{s.name}</span>
      {s.windows > 1 && <span className="text-[11px] text-faint">{t.sidebar.windows(s.windows - 1)}</span>}
      <span
        className={`shrink-0 text-[12px] group-hover:hidden ${st.ui === 'waiting' ? 'text-st-waiting' : st.ui === 'busy' ? 'text-st-busy' : 'text-muted'}`}
      >
        {word}
      </span>
    </Row>
  );
}

// ---------------------------------------------------------------- Проекты
function ProjectList({ filter }: { filter: string }) {
  const projects = useData((d) => d.projects);
  const chats = useData((d) => d.chats);
  const home = useData((d) => d.hello?.home ?? null);
  const selection = useUi((u) => u.selection);
  const expanded = useUi((u) => u.expanded);
  const H = useRowHeights();
  const byProject = useMemo(() => {
    const m = new Map<string, Chat[]>();
    for (const c of Object.values(chats)) {
      if (c.archived || !c.project) continue;
      const l = m.get(c.project) ?? [];
      l.push(c);
      m.set(c.project, l);
    }
    for (const l of m.values()) l.sort((a, b) => b.lastAt - a.lastAt);
    return m;
  }, [chats]);
  const list = projects.filter((p) => matches(filter, p.name, p.path, p.git?.branch));
  if (!list.length) return <Empty text={filter ? t.sidebar.notFound(filter) : t.sidebar.noChats} />;
  return (
    <div className="px-1.5 py-1" data-list="projects">
      {list.map((p) => {
        const open = !!expanded[p.path];
        const pc = byProject.get(p.path) ?? [];
        return (
          <div key={p.path}>
            <Row
              testid={`project-${p.name}`}
              selected={selection?.kind === 'project' && selection.path === p.path}
              height={H.row}
              title={shortPath(p.path, home)}
              onSelect={() => sel().setSelection({ kind: 'project', path: p.path })}
              onOpen={() => A.projectMain(p)}
              menu={() => projectMenu(p)}
            >
              <button
                aria-label={open ? 'Свернуть' : 'Раскрыть'}
                className="-ml-1 rounded p-0.5 text-muted hover:bg-selected"
                onClick={(e) => {
                  e.stopPropagation();
                  sel().set({ expanded: { ...expanded, [p.path]: !open } });
                }}
              >
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
              {p.liveSession ? (
                <StatusIcon status={claudeUi(p.liveStatus)} size={12} />
              ) : (
                <span className="w-3" />
              )}
              <span className="min-w-0 truncate">{p.name}</span>
              {p.git && <span className="min-w-0 shrink truncate text-[12px] text-git">{p.git.branch}</span>}
              {p.git?.dirty && (
                <span className="text-dirty" title="есть незакоммиченные изменения">
                  ✱
                </span>
              )}
              <span className="flex-1" />
              <span className="tnum shrink-0 text-[12px] text-muted group-hover:hidden">
                {formatAgo(p.lastAt)}
              </span>
            </Row>
            {open && (
              <div className="pl-6">
                {pc.slice(0, 10).map((c) => (
                  <NestedChat
                    key={c.id}
                    c={c}
                    height={H.nested}
                    selected={selection?.kind === 'chat' && selection.id === c.id}
                  />
                ))}
                {pc.length === 0 && (
                  <div className="px-2 py-0.5 text-[12px] text-faint">{t.sidebar.noChats}</div>
                )}
                {pc.length > 10 && (
                  <button
                    className="px-2 text-[12px] text-muted hover:text-fg"
                    onClick={() => {
                      sel().setLayout({ sidebarTab: 'chats' });
                      sel().set({ projectFilter: p.path });
                    }}
                  >
                    {t.sidebar.allProjectChats(pc.length)}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function NestedChat({ c, height, selected }: { c: Chat; height: number; selected: boolean }) {
  return (
    <Row
      testid={`chat-${c.id}`}
      selected={selected}
      height={height}
      onSelect={() => sel().setSelection({ kind: 'chat', id: c.id })}
      onOpen={() => void A.continueChat(c)}
      menu={() => chatMenu(c)}
    >
      {c.open ? <StatusIcon status={claudeUi(c.open.status)} size={12} /> : <span className="w-3" />}
      <span className="min-w-0 flex-1 truncate text-[13px]">{c.title}</span>
      <span className="tnum shrink-0 text-[12px] text-muted group-hover:hidden">{formatAgo(c.lastAt)}</span>
    </Row>
  );
}

// ---------------------------------------------------------------- Чаты / Архив
type ListItem = { kind: 'head'; group: DayGroup } | { kind: 'chat'; chat: Chat };
const GROUP_LABEL: Record<DayGroup, string> = {
  today: t.sidebar.today,
  yesterday: t.sidebar.yesterday,
  week: t.sidebar.week,
  earlier: t.sidebar.earlier,
};

export function buildChatItems(chats: Chat[], now = Date.now()): ListItem[] {
  const out: ListItem[] = [];
  let last: DayGroup | null = null;
  for (const c of chats) {
    const g = dayGroup(c.lastAt, now);
    if (g !== last) {
      out.push({ kind: 'head', group: g });
      last = g;
    }
    out.push({ kind: 'chat', chat: c });
  }
  return out;
}

function ChatList({ archived, filter }: { archived: boolean; filter: string }) {
  const chats = useData((d) => d.chats);
  const projects = useData((d) => d.projects);
  const home = useData((d) => d.hello?.home ?? null);
  const projectFilter = useUi((u) => u.projectFilter);
  const selection = useUi((u) => u.selection);
  const H = useRowHeights();
  const nameOf = useMemo(() => new Map(projects.map((p) => [p.path, p.name])), [projects]);
  const list = useMemo(
    () =>
      Object.values(chats)
        .filter((c) => c.archived === archived)
        .filter((c) => !projectFilter || c.project === projectFilter)
        .filter((c) =>
          matches(filter, c.title, c.project ? (nameOf.get(c.project) ?? c.project) : null, c.firstPrompt),
        )
        .sort((a, b) => b.lastAt - a.lastAt),
    [chats, archived, filter, projectFilter, nameOf],
  );
  const items = useMemo(() => buildChatItems(list), [list]);
  const parent = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => parent.current,
    estimateSize: (i) => (items[i]?.kind === 'head' ? 20 : H.chat),
    overscan: 12,
  });
  // a chat selected from elsewhere (e.g. «в списке чатов» in the right panel) is scrolled into view
  const selectedChat = selection?.kind === 'chat' ? selection.id : null;
  useEffect(() => {
    if (!selectedChat) return;
    const i = items.findIndex((it) => it.kind === 'chat' && it.chat.id === selectedChat);
    if (i >= 0) v.scrollToIndex(i, { align: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChat]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {projectFilter && (
        <div className="mx-2 mt-1 flex items-center gap-1 rounded bg-accent-soft px-2 py-0.5 text-[12px]">
          <span className="min-w-0 flex-1 truncate">
            {nameOf.get(projectFilter) ?? shortPath(projectFilter, home)}
          </span>
          <button aria-label="Сбросить фильтр проекта" onClick={() => sel().set({ projectFilter: null })}>
            <X size={12} />
          </button>
        </div>
      )}
      {!items.length ? (
        <>
          <Empty
            text={filter ? t.sidebar.notFound(filter) : archived ? t.sidebar.archiveEmpty : t.sidebar.noChats}
          />
          {filter.trim().length >= 2 && <SearchInText filter={filter} />}
        </>
      ) : (
        <div
          ref={parent}
          className="min-h-0 flex-1 overflow-y-auto px-1.5"
          data-list={archived ? 'archive' : 'chats'}
        >
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {v.getVirtualItems().map((vi) => {
              const it = items[vi.index] as ListItem;
              return (
                <div
                  key={vi.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  {it.kind === 'head' ? (
                    <div className="sticky top-0 flex h-5 items-end bg-surface px-2 text-[11px] font-semibold uppercase tracking-[.06em] text-faint">
                      {GROUP_LABEL[it.group]}
                    </div>
                  ) : (
                    <ChatRow
                      c={it.chat}
                      height={H.chat}
                      selected={selection?.kind === 'chat' && selection.id === it.chat.id}
                      projectName={
                        it.chat.project
                          ? (nameOf.get(it.chat.project) ?? shortPath(it.chat.project, home))
                          : '‹папка?›'
                      }
                    />
                  )}
                </div>
              );
            })}
          </div>
          <SearchInText filter={filter} />
        </div>
      )}
    </div>
  );
}

function ChatRow({
  c,
  height,
  selected,
  projectName,
}: {
  c: Chat;
  height: number;
  selected: boolean;
  projectName: string;
}) {
  return (
    <Row
      testid={`chat-${c.id}`}
      selected={selected}
      height={height}
      title={c.firstPrompt ?? undefined}
      onSelect={() => sel().setSelection({ kind: 'chat', id: c.id })}
      onOpen={() => void A.continueChat(c)}
      menu={() => chatMenu(c)}
    >
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div className="flex min-w-0 items-center gap-1.5">
          {c.open && <StatusIcon status={claudeUi(c.open.status)} size={12} />}
          <span className="min-w-0 truncate">{c.title}</span>
        </div>
        <div className="tnum truncate text-[12px] text-muted">
          {projectName} · {formatAgo(c.lastAt)} · {t.sidebar.prompts(c.prompts, c.promptsApprox)}
        </div>
      </div>
    </Row>
  );
}

/** «Искать в тексте чатов…»: opens the full-text search (agent, stage 6) with the filter as the query */
function SearchInText({ filter }: { filter: string }) {
  const q = filter.trim();
  return (
    <button
      type="button"
      data-testid="search-in-text"
      className="block w-full truncate px-2 py-2 text-left text-[12px] text-faint hover:text-fg"
      onClick={() => sel().set({ chatSearch: q })}
    >
      {q.length >= 2 ? t.sidebar.searchInTextQ(q) : t.sidebar.searchInText}
    </button>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="px-4 py-6 text-center text-[12px] text-muted">{text}</div>;
}

// ---------------------------------------------------------------- Sidebar
export function Sidebar() {
  const tab = useUi((u) => u.layout.sidebarTab);
  const filter = useUi((u) => u.filter);
  const stale = useData((d) => d.stale);
  const online = useConn((c) => c.state.kind === 'online');
  const [focusFilter] = useState(0);
  const tabs: { id: 'projects' | 'chats' | 'archive'; label: string }[] = [
    { id: 'projects', label: t.sidebar.projects },
    { id: 'chats', label: t.sidebar.chats },
    { id: 'archive', label: t.sidebar.archive },
  ];
  return (
    <aside data-sidebar className="flex h-full min-h-0 flex-col bg-surface" key={focusFilter}>
      <ActiveSection />
      <div className="shrink-0 px-2 pt-2">
        <div className="flex rounded-[6px] bg-base p-0.5" role="tablist">
          {tabs.map((x) => (
            <button
              key={x.id}
              role="tab"
              aria-selected={tab === x.id}
              data-sidebar-focus={x.id === tab ? '' : undefined}
              className={`h-6 flex-1 rounded-[4px] text-[12px] ${tab === x.id ? 'bg-selected text-fg' : 'text-muted hover:text-fg'}`}
              onClick={() => {
                sel().setLayout({ sidebarTab: x.id });
                sel().set({ projectFilter: null });
              }}
            >
              {x.label}
            </button>
          ))}
        </div>
        <div className="mt-1.5 flex items-center gap-1">
          <div className="flex h-7 flex-1 items-center gap-1.5 rounded-[4px] border border-line-strong bg-base px-2 focus-within:border-accent">
            <Search size={13} className="text-faint" />
            <input
              data-filter
              value={filter}
              onChange={(e) => sel().set({ filter: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape') sel().set({ filter: '' });
                if (e.key === 'ArrowDown')
                  document.querySelector<HTMLElement>('[data-list] [data-row]')?.focus();
              }}
              placeholder={t.sidebar.filter}
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
            />
            {filter && (
              <button aria-label="Очистить фильтр" onClick={() => sel().set({ filter: '' })}>
                <X size={12} className="text-muted" />
              </button>
            )}
          </div>
          <DropdownMenu
            align="end"
            trigger={
              <button
                aria-label="Создать"
                className="rounded p-1 text-muted hover:bg-hover hover:text-fg disabled:opacity-40"
                disabled={!online}
              >
                <Plus size={15} />
              </button>
            }
            items={[
              { label: t.actions.createProject, run: () => sel().set({ dialog: { kind: 'createProject' } }) },
              { label: t.actions.clone, run: () => sel().set({ dialog: { kind: 'clone' } }) },
            ]}
          />
        </div>
        {stale && <div className="px-1 pt-1 text-[11px] text-faint">{t.sidebar.stale}</div>}
      </div>
      <div
        className={`flex min-h-0 flex-1 flex-col ${tab === 'projects' ? 'overflow-y-auto' : ''} ${stale ? 'opacity-60' : ''}`}
      >
        {tab === 'projects' && <ProjectList filter={filter} />}
        {tab === 'chats' && <ChatList archived={false} filter={filter} />}
        {tab === 'archive' && <ChatList archived filter={filter} />}
      </div>
    </aside>
  );
}
