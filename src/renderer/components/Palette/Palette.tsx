import { Command as Cmdk } from 'cmdk';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { Chat, Project, Session } from '@shared/model';
import * as A from '../../actions';
import { getCommands } from '../../commands';
import { t } from '../../i18n/ru';
import { formatAgo } from '../../lib/format';
import { fuzzyScore } from '../../lib/fuzzy';
import { claudeUi, sessionStatus } from '../../lib/status';
import { useConn } from '../../stores/conn';
import { useData } from '../../stores/data';
import { useUi } from '../../stores/ui';
import { chatMenu, projectMenu, sessionMenu } from '../menus';
import type { MenuEntry, MenuItem } from '../ui/Menu';
import { StatusIcon } from '../ui/StatusIcon';

interface Entry {
  key: string;
  group: 'recent' | 'sessions' | 'chats' | 'projects' | 'actions' | 'search';
  title: string;
  meta?: string;
  hint?: string;
  icon?: React.ReactNode;
  needsVm?: boolean;
  run: () => void;
  secondary?: () => MenuEntry[];
  score: number;
}

const recent: string[] = [];
function remember(key: string) {
  const i = recent.indexOf(key);
  if (i >= 0) recent.splice(i, 1);
  recent.unshift(key);
  recent.splice(5);
}

const GROUPS: { id: Entry['group']; label: string }[] = [
  { id: 'recent', label: t.palette.recent },
  { id: 'sessions', label: t.palette.sessions },
  { id: 'chats', label: t.palette.chats },
  { id: 'projects', label: t.palette.projects },
  { id: 'actions', label: t.palette.actions },
  { id: 'search', label: t.palette.search },
];

/** «Искать … в тексте чатов»: the full-text search through transcripts on the VM (stage 6) */
function searchEntry(query: string): Entry {
  return {
    key: 'fts',
    group: 'search',
    title: t.palette.searchText(query),
    hint: '⏎',
    icon: <Search size={13} className="text-faint" />,
    needsVm: true,
    run: () => useUi.getState().set({ chatSearch: query }),
    score: 1,
  };
}

function sessionEntry(s: Session, q: string): Entry {
  const st = sessionStatus(s);
  return {
    key: `s:${s.name}`,
    group: 'sessions',
    title: s.name,
    meta: s.claude.length ? t.status[st.ui] : s.command,
    hint: '⏎ перейти',
    icon: <StatusIcon status={st.ui} size={13} />,
    run: () => A.openSession(s.name),
    secondary: () => sessionMenu(s),
    score: fuzzyScore(q, s.name),
  };
}

function chatEntry(c: Chat, pname: string, q: string): Entry {
  return {
    key: `c:${c.id}`,
    group: 'chats',
    title: c.title,
    meta: `${pname} · ${formatAgo(c.lastAt)}`,
    hint: c.open ? '⏎ перейти' : '⏎ продолжить',
    icon: c.open ? <StatusIcon status={claudeUi(c.open.status)} size={13} /> : <span className="w-[13px]" />,
    needsVm: true,
    run: () => void A.continueChat(c),
    secondary: () => chatMenu(c),
    score: Math.max(
      fuzzyScore(q, c.title),
      fuzzyScore(q, pname) * 0.6,
      c.firstPrompt ? fuzzyScore(q, c.firstPrompt) * 0.5 : 0,
    ),
  };
}

function projectEntry(p: Project, q: string): Entry {
  return {
    key: `p:${p.path}`,
    group: 'projects',
    title: p.name,
    meta: p.git ? `${p.git.branch}${p.git.dirty ? ' ✱' : ''}` : undefined,
    hint: p.liveSession ? '⏎ перейти' : '⏎ новый чат',
    icon: p.liveSession ? (
      <StatusIcon status={claudeUi(p.liveStatus)} size={13} />
    ) : (
      <span className="w-[13px]" />
    ),
    needsVm: true,
    run: () => A.projectMain(p),
    secondary: () => projectMenu(p),
    score: Math.max(fuzzyScore(q, p.name), fuzzyScore(q, p.path) * 0.5),
  };
}

export function Palette() {
  const open = useUi((u) => u.palette);
  const sessions = useData((d) => d.sessions);
  const chats = useData((d) => d.chats);
  const projects = useData((d) => d.projects);
  const online = useConn((c) => c.state.kind === 'online');
  const [q, setQ] = useState('');
  const [value, setValue] = useState('');
  const [secondary, setSecondary] = useState<{ title: string; items: MenuItem[] } | null>(null);

  const close = () => {
    useUi.getState().set({ palette: false });
    setQ('');
    setSecondary(null);
  };

  const entries = useMemo(() => {
    if (!open) return [] as Entry[];
    let query = q.trim();
    let only: Entry['group'] | null = null;
    if (query.startsWith('>')) [only, query] = ['actions', query.slice(1).trim()];
    else if (query.startsWith('@')) [only, query] = ['projects', query.slice(1).trim()];
    else if (query.startsWith('#')) [only, query] = ['chats', query.slice(1).trim()];
    else if (query.startsWith('?')) [only, query] = ['search', query.slice(1).trim()];
    const pname = new Map(projects.map((p) => [p.path, p.name]));
    const actions: Entry[] = getCommands().map((c) => ({
      key: `a:${c.id}`,
      group: 'actions',
      title: c.title,
      hint: c.hotkey,
      needsVm: c.needsVm,
      run: c.run,
      score: fuzzyScore(query, c.title),
    }));
    const all: Entry[] = [];
    if (!query && !only) {
      const byKey = new Map<string, Entry>();
      for (const s of sessions) byKey.set(`s:${s.name}`, sessionEntry(s, ''));
      for (const a of actions) byKey.set(a.key, a);
      for (const c of Object.values(chats))
        byKey.set(`c:${c.id}`, chatEntry(c, c.project ? (pname.get(c.project) ?? c.project) : '', ''));
      for (const p of projects) byKey.set(`p:${p.path}`, projectEntry(p, ''));
      for (const k of recent) {
        const e = byKey.get(k);
        if (e) all.push({ ...e, group: 'recent', key: `r:${k}` });
      }
      all.push(...sessions.map((s) => sessionEntry(s, '')));
      all.push(...actions);
      return all;
    }
    if (!only) all.push(...sessions.map((s) => sessionEntry(s, query)));
    if (!only || only === 'chats')
      all.push(
        ...Object.values(chats)
          .filter((c) => !c.archived)
          .map((c) => chatEntry(c, c.project ? (pname.get(c.project) ?? c.project) : '', query)),
      );
    if (!only || only === 'projects') all.push(...projects.map((p) => projectEntry(p, query)));
    if (!only || only === 'actions') all.push(...actions);
    if ((!only || only === 'chats' || only === 'search') && query.length >= 2) all.push(searchEntry(query));
    return all.filter((e) => e.score > 0);
  }, [open, q, sessions, chats, projects]);

  const grouped = GROUPS.map((g) => ({
    ...g,
    items: entries
      .filter((e) => e.group === g.id)
      .sort((a, b) => (q.trim() ? b.score - a.score : 0))
      .slice(0, 10),
  })).filter((g) => g.items.length);

  const run = (e: Entry) => {
    if (e.needsVm && !online) return;
    remember(e.key.replace(/^r:/, ''));
    close();
    e.run();
  };

  const findEntry = (key: string) => grouped.flatMap((g) => g.items).find((e) => e.key === key);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          className="fixed left-1/2 top-[15%] z-50 w-[640px] max-w-[92vw] -translate-x-1/2 overflow-hidden rounded-[8px] border border-line-strong bg-elevated shadow-float"
          aria-describedby={undefined}
        >
          <Dialog.Title className="sr-only">{t.actions.palette}</Dialog.Title>
          <Cmdk
            shouldFilter={false}
            value={value}
            onValueChange={setValue}
            loop
            onKeyDown={(e) => {
              if (e.key === 'Tab' && !secondary) {
                e.preventDefault();
                const cur = findEntry(value);
                if (cur?.secondary)
                  setSecondary({
                    title: cur.title,
                    items: cur.secondary().filter((x): x is MenuItem => x !== 'sep'),
                  });
              } else if ((e.key === 'Escape' || (e.key === 'Backspace' && !q)) && secondary) {
                e.preventDefault();
                setSecondary(null);
              }
            }}
          >
            <div className="flex items-center gap-2 border-b border-line px-3">
              <Search size={15} className="text-faint" />
              <Cmdk.Input
                value={q}
                onValueChange={setQ}
                placeholder={secondary ? t.palette.secondary(secondary.title) : t.palette.placeholder}
                className="h-11 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint"
                autoFocus
              />
            </div>
            <Cmdk.List className="max-h-[60vh] overflow-y-auto p-1">
              <Cmdk.Empty className="px-3 py-6 text-center text-[12px] text-muted">
                {t.palette.empty}
              </Cmdk.Empty>
              {secondary ? (
                <Cmdk.Group heading={<span className="section-title px-2">{secondary.title}</span>}>
                  {secondary.items.map((it, i) => (
                    <Cmdk.Item
                      key={i}
                      value={`sec:${i}`}
                      disabled={it.disabled}
                      onSelect={() => {
                        close();
                        it.run();
                      }}
                      className="flex h-8 cursor-default items-center gap-2 rounded px-2 text-[13px] data-[selected=true]:bg-selected data-[disabled=true]:opacity-40"
                    >
                      <span className="w-4 text-muted">{it.icon}</span>
                      <span className={it.danger ? 'text-st-error' : ''}>{it.label}</span>
                    </Cmdk.Item>
                  ))}
                </Cmdk.Group>
              ) : (
                grouped.map((g) => (
                  <Cmdk.Group key={g.id} heading={<span className="section-title px-2">{g.label}</span>}>
                    {g.items.map((e) => {
                      const off = e.needsVm && !online;
                      return (
                        <Cmdk.Item
                          key={e.key}
                          value={e.key}
                          onSelect={() => run(e)}
                          className={`flex h-8 cursor-default items-center gap-2 rounded px-2 text-[13px] data-[selected=true]:bg-selected ${off ? 'opacity-40' : ''}`}
                        >
                          {e.icon}
                          <span className="min-w-0 flex-1 truncate">{e.title}</span>
                          {e.meta && (
                            <span className="shrink-0 truncate text-[12px] text-muted">{e.meta}</span>
                          )}
                          <span className="shrink-0 text-[11px] text-faint">
                            {off ? t.palette.offline : e.hint}
                          </span>
                        </Cmdk.Item>
                      );
                    })}
                  </Cmdk.Group>
                ))
              )}
            </Cmdk.List>
            <div className="border-t border-line px-3 py-1.5 text-[11px] text-faint">{t.palette.hint}</div>
          </Cmdk>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
