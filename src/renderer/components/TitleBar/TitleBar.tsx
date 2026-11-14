import {
  ChevronDown,
  Command,
  GitBranch,
  Monitor,
  Plus,
  Settings as SettingsIcon,
  SquareTerminal,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Tab, UiStatus } from '@shared/model';
import * as A from '../../actions';
import { invoke } from '../../bridge';
import { t } from '../../i18n/ru';
import { formatAgo } from '../../lib/format';
import { sessionStatus } from '../../lib/status';
import { useConn } from '../../stores/conn';
import { useData } from '../../stores/data';
import { useTabs } from '../../stores/tabs';
import { useUi } from '../../stores/ui';
import { tabMenu } from '../menus';
import { IconButton } from '../ui/Button';
import { ContextMenu, DropdownMenu } from '../ui/Menu';
import { StatusIcon } from '../ui/StatusIcon';

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function ConnDot({ withLabel = false }: { withLabel?: boolean }) {
  const s = useConn((c) => c.state);
  const color =
    s.kind === 'online'
      ? 'bg-st-idle'
      : s.kind === 'connecting'
        ? 'bg-st-waiting anim-pulse'
        : s.kind === 'needs-user'
          ? 'bg-st-waiting'
          : 'bg-st-error';
  const label =
    s.kind === 'online'
      ? t.conn.online
      : s.kind === 'connecting'
        ? t.conn.connecting
        : s.kind === 'needs-user'
          ? t.conn.needsUser
          : s.kind === 'idle'
            ? t.conn.idle
            : t.conn.offline;
  return (
    <span className="inline-flex items-center gap-1.5" data-conn={s.kind}>
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
      {withLabel && <span>{label}</span>}
    </span>
  );
}

export function ConnPopover({
  onClose,
  where = 'title',
}: {
  onClose: () => void;
  where?: 'title' | 'status';
}) {
  const s = useConn((c) => c.state);
  const hello = useData((d) => d.hello);
  const dev = useUi((u) => !!u.appInfo?.dev);
  const now = useNow();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', h);
    window.addEventListener('keydown', k);
    return () => {
      window.removeEventListener('mousedown', h);
      window.removeEventListener('keydown', k);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className={`no-drag absolute left-2 z-50 ${where === 'title' ? 'top-9' : 'bottom-7'} w-72 rounded-[8px] border border-line-strong bg-elevated p-3 text-[12px] text-fg shadow-float`}
    >
      <div className="mb-2 flex items-center gap-2 text-[13px] font-medium">
        <ConnDot withLabel />
      </div>
      <div className="space-y-1 text-muted">
        <div>{s.kind === 'online' ? s.host : hello ? `${hello.user}@${hello.host}` : '—'}</div>
        {s.kind === 'online' && (
          <>
            <div className="tnum">{t.conn.rtt(s.rttMs)}</div>
            <div className="tnum">{t.conn.since(formatAgo(s.since, now))}</div>
            <div>агент {s.agent}</div>
          </>
        )}
        {s.kind === 'offline' && (
          <>
            <div className="text-st-error">{s.error}</div>
            <div className="tnum">{t.conn.retryIn(Math.max(0, Math.ceil((s.retryAt - now) / 1000)))}</div>
          </>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className="rounded border border-line-strong px-2 py-1 hover:bg-hover"
          onClick={() => void invoke('conn.retryNow')}
        >
          {t.conn.reconnect}
        </button>
        <button
          className="rounded border border-line-strong px-2 py-1 hover:bg-hover"
          onClick={() => void invoke('conn.disconnect')}
        >
          {t.conn.disconnect}
        </button>
      </div>
      {dev && (
        <div className="mt-2 flex flex-col gap-1 border-t border-line pt-2">
          <button
            className="text-left text-faint hover:text-fg"
            onClick={() => void invoke('conn.debugDrop')}
          >
            {t.conn.debugDrop}
          </button>
          <button
            className="text-left text-faint hover:text-fg"
            onClick={() => void invoke('conn.debugFreeze')}
          >
            {t.conn.debugFreeze}
          </button>
        </div>
      )}
    </div>
  );
}

function tabStatus(
  tab: Tab,
  sessionsStatus: Map<string, { ui: UiStatus; raw: string | null }>,
  online: boolean,
): UiStatus {
  if (!online || tab.term === 'offline') return 'offline';
  if (tab.term === 'ended' || tab.term === 'error') return 'error';
  if (tab.kind !== 'tmux') return 'none';
  return (tab.session && sessionsStatus.get(tab.session)?.ui) || 'none';
}

function TabButton({
  tab,
  index,
  active,
  status,
}: {
  tab: Tab;
  index: number;
  active: boolean;
  status: UiStatus;
}) {
  const sessions = useData((d) => d.sessions);
  const chats = useData((d) => d.chats);
  const s = tab.session ? sessions.find((x) => x.name === tab.session) : undefined;
  const chat = s?.claude[0] ? chats[s.claude[0].chatId] : tab.chatId ? chats[tab.chatId] : undefined;
  // title: session name; if Claude runs in it — project folder name
  const title = chat?.project ? chat.project.split('/').pop() || tab.title : tab.title;
  const tip = [chat?.title, s?.path ?? tab.cwd, t.status[status] || status].filter(Boolean).join('\n');
  return (
    <ContextMenu items={() => tabMenu(tab)}>
      <div
        role="tab"
        aria-selected={active}
        data-tab={tab.session ?? tab.title}
        title={tip}
        draggable
        onDragStart={(e) => e.dataTransfer.setData('text/x-cs-tab', String(index))}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const from = Number(e.dataTransfer.getData('text/x-cs-tab'));
          if (!Number.isNaN(from) && from !== index) useTabs.getState().move(from, index);
        }}
        onMouseDown={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            A.closeTab(tab.id);
          }
        }}
        onClick={() => A.focusTab(tab.id)}
        className={`no-drag group relative flex h-[30px] min-w-[120px] max-w-[220px] shrink-0 cursor-default items-center gap-1.5 rounded-t-[6px] px-2 text-[13px] ${active ? 'bg-base text-fg' : 'text-muted hover:bg-hover'}`}
      >
        {active && <span className="absolute inset-x-0 top-0 h-[2px] rounded-t bg-accent" />}
        {tab.kind === 'tmux' ? (
          <StatusIcon status={status} />
        ) : tab.kind === 'lazygit' ? (
          <GitBranch size={14} className="text-st-none" />
        ) : (
          <SquareTerminal size={14} className="text-st-none" />
        )}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <button
          aria-label={t.actions.closeTab}
          className={`rounded p-0.5 hover:bg-selected ${active ? 'opacity-60' : 'opacity-0 group-hover:opacity-60'} hover:!opacity-100`}
          onClick={(e) => {
            e.stopPropagation();
            A.closeTab(tab.id);
          }}
        >
          <X size={12} />
        </button>
      </div>
    </ContextMenu>
  );
}

export function TitleBar() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const sessions = useData((d) => d.sessions);
  const online = useConn((c) => c.state.kind === 'online');
  const [pop, setPop] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);
  const st = new Map(sessions.map((s) => [s.name, sessionStatus(s)]));
  const platform = window.cs?.platform ?? 'win32';
  return (
    <header
      className="drag relative flex h-9 shrink-0 items-end border-b border-line bg-surface pl-2"
      style={{ paddingRight: platform === 'darwin' ? 8 : 140 }}
    >
      <div className="flex h-9 items-center gap-2 pr-2">
        <button
          className="no-drag flex items-center gap-2 rounded px-1 py-0.5 hover:bg-hover"
          onClick={() => setPop((p) => !p)}
          title="Соединение"
        >
          <span className="text-[15px] text-accent">◆</span>
          <span className="text-[13px] font-semibold">ClaudeSpace</span>
          <ConnDot />
        </button>
        {pop && <ConnPopover onClose={() => setPop(false)} />}
      </div>
      <div className="h-6 w-px self-center bg-line" />
      <div
        ref={stripRef}
        role="tablist"
        className="no-drag ml-1 flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto overflow-y-hidden"
        style={{ scrollbarWidth: 'none' }}
        onWheel={(e) => {
          if (stripRef.current) stripRef.current.scrollLeft += e.deltaY;
        }}
      >
        {tabs.map((tab, i) => (
          <TabButton
            key={tab.id}
            tab={tab}
            index={i}
            active={tab.id === activeId}
            status={tabStatus(tab, st, online)}
          />
        ))}
        <div className="flex h-[30px] shrink-0 items-center">
          <IconButton
            title={`${t.actions.newChat} (Ctrl+Shift+N)`}
            onClick={() => A.newChatHere()}
            disabled={!online}
          >
            <Plus size={15} />
          </IconButton>
          <DropdownMenu
            trigger={
              <button
                className="no-drag -ml-1 rounded p-1 text-muted hover:bg-hover"
                aria-label="Меню новой вкладки"
              >
                <ChevronDown size={12} />
              </button>
            }
            items={[
              {
                label: t.actions.newChatDots,
                hint: 'Ctrl+Shift+T',
                run: () => useUi.getState().set({ dialog: { kind: 'newChat' } }),
              },
              { label: t.actions.shellHome, run: () => A.openTemp('shell', A.homeDir()) },
              {
                label: t.actions.lazygit,
                hint: 'Ctrl+Shift+G',
                disabled: !A.activeCwd(),
                run: () => A.openTemp('lazygit', A.activeCwd() ?? A.homeDir()),
              },
              ...(tabs.length > 6
                ? (['sep', ...tabs.map((x) => ({ label: x.title, run: () => A.focusTab(x.id) }))] as const)
                : []),
            ]}
          />
        </div>
      </div>
      <div className="no-drag flex h-9 items-center gap-0.5 pl-2">
        <IconButton
          title="Палитра команд (Ctrl+K, Ctrl+Shift+P)"
          onClick={() => useUi.getState().set({ palette: true })}
        >
          <Command size={15} />
        </IconButton>
        <IconButton title={`${t.actions.rdp} (Ctrl+Alt+R)`} onClick={() => A.openRdp()}>
          <Monitor size={15} />
          <span className="ml-1 text-[12px]">RDP</span>
        </IconButton>
        <IconButton
          title={`${t.actions.settings} (Ctrl+,)`}
          onClick={() => useUi.getState().set({ settingsOpen: 'connection' })}
        >
          <SettingsIcon size={15} />
        </IconButton>
      </div>
    </header>
  );
}
