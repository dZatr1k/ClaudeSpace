import {
  BookText,
  Columns2,
  LayoutGrid,
  Rows2,
  Square,
  ChevronDown,
  GitBranch,
  LoaderCircle,
  Monitor,
  Plus,
  Search,
  Settings as SettingsIcon,
  SquareTerminal,
  TriangleAlert,
  WifiOff,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Tab, UiStatus } from '@shared/model';
import * as A from '../../actions';
import { invoke } from '../../bridge';
import { openClaudeScreen } from '../Overlays/ClaudeScreen';
import type { SplitMode } from '../../lib/panes';
import { SPLIT_MODES } from '../../lib/panes';
import { t } from '../../i18n/ru';
import { formatAgo } from '../../lib/format';
import { sessionStatus } from '../../lib/status';
import { useConn } from '../../stores/conn';
import { useData } from '../../stores/data';
import { useTabs } from '../../stores/tabs';
import { useUi } from '../../stores/ui';
import { tabMenu } from '../menus';
import { Button, IconButton, Kbd } from '../ui/Button';
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

/** Connection state as shape + colour (DESIGN §5.2): dot · spinning ring · WifiOff · triangle. */
export function ConnDot({ withLabel = false, size = 12 }: { withLabel?: boolean; size?: number }) {
  const s = useConn((c) => c.state);
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
  const icon =
    s.kind === 'online' ? (
      <span className="inline-block h-2 w-2 rounded-full bg-st-idle" />
    ) : s.kind === 'connecting' ? (
      <LoaderCircle size={size} strokeWidth={2.2} className="anim-spin text-st-waiting" aria-hidden />
    ) : s.kind === 'needs-user' ? (
      <TriangleAlert size={size} strokeWidth={2.2} className="text-st-waiting" aria-hidden />
    ) : (
      <WifiOff size={size} strokeWidth={2.2} className="text-st-error" aria-hidden />
    );
  return (
    <span className="inline-flex items-center gap-1.5" data-conn={s.kind}>
      <span
        className="inline-flex items-center justify-center"
        style={{ width: size, height: size }}
        role="img"
        aria-label={label}
      >
        {icon}
      </span>
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
      role="dialog"
      aria-label={t.conn.title}
      className={`anim-slide-l no-drag absolute left-2 z-50 ${where === 'title' ? 'top-10' : 'bottom-8'} w-72 rounded-[10px] border border-line-strong bg-elevated p-4 text-[12px] text-fg shadow-pop`}
    >
      <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold">
        <ConnDot withLabel size={14} />
      </div>
      <div className="space-y-1 text-muted">
        <div className="mono text-fg">
          {s.kind === 'online' ? s.host : hello ? `${hello.user}@${hello.host}` : '?'}
        </div>
        {s.kind === 'online' && (
          <>
            <div className="tnum">{t.conn.rtt(s.rttMs)}</div>
            <div className="tnum">{t.conn.since(formatAgo(s.since, now))}</div>
            <div>{t.conn.agent(s.agent)}</div>
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
        <Button small onClick={() => void invoke('conn.retryNow')}>
          {t.conn.reconnect}
        </Button>
        <Button small variant="ghost" onClick={() => void invoke('conn.disconnect')}>
          {t.conn.disconnect}
        </Button>
      </div>
      {dev && (
        <div className="mt-2 flex flex-col gap-1 border-t border-line pt-2">
          <button
            className="text-left text-faint hover:text-fg hover:underline"
            onClick={() => void invoke('conn.debugDrop')}
          >
            {t.conn.debugDrop}
          </button>
          <button
            className="text-left text-faint hover:text-fg hover:underline"
            onClick={() => void invoke('conn.debugFreeze')}
          >
            {t.conn.debugFreeze}
          </button>
        </div>
      )}
    </div>
  );
}

const SPLIT_ICON: Record<SplitMode, typeof Square> = {
  single: Square,
  cols: Columns2,
  rows: Rows2,
  grid: LayoutGrid,
};

/** split view: one tab, two side by side, two stacked, four (lib/panes.ts) */
function SplitMenu() {
  const split = useTabs((s) => s.split);
  const Icon = SPLIT_ICON[split];
  return (
    <DropdownMenu
      align="end"
      items={[
        ...SPLIT_MODES.map((m) => {
          const I = SPLIT_ICON[m];
          return {
            label: t.split.modes[m] ?? m,
            icon: <I size={13} />,
            hint: m === split ? '✓' : undefined,
            run: () => useTabs.getState().setSplit(m),
          };
        }),
        'sep' as const,
        {
          label: t.split.next,
          hint: 'Ctrl+Alt+→',
          disabled: split === 'single',
          run: () => useTabs.getState().cyclePane(1),
        },
      ]}
      trigger={
        <button
          type="button"
          title={t.split.menu}
          aria-label={t.split.menu}
          data-testid="split-menu"
          className="no-drag flex h-7 items-center rounded-[6px] px-1.5 text-muted transition-colors duration-100 hover:bg-hover hover:text-fg active:bg-selected"
        >
          <Icon size={15} aria-hidden />
        </button>
      }
    />
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
        className={`no-drag group relative flex h-[31px] min-w-[120px] max-w-[220px] shrink-0 items-center gap-1.5 rounded-t-[6px] pl-2.5 pr-1.5 text-[13px] transition-colors duration-100 ${active ? 'bg-base font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg'} ${status === 'waiting' && !active ? 'text-fg' : ''}`}
      >
        {active && <span className="absolute inset-x-1.5 top-0 h-[2px] rounded-b bg-accent" />}
        {tab.kind === 'tmux' ? (
          <StatusIcon status={status} />
        ) : tab.kind === 'lazygit' ? (
          <GitBranch size={14} className="shrink-0 text-st-none" aria-hidden />
        ) : (
          <SquareTerminal size={14} className="shrink-0 text-st-none" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <button
          aria-label={t.actions.closeTab}
          className={`rounded-[4px] p-0.5 text-muted hover:bg-selected hover:text-fg ${active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70 focus-visible:opacity-100'} hover:!opacity-100`}
          onClick={(e) => {
            e.stopPropagation();
            A.closeTab(tab.id);
          }}
        >
          <X size={12} aria-hidden />
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
          className="no-drag flex h-7 items-center gap-2 rounded-[6px] px-2 hover:bg-hover active:bg-selected"
          onClick={() => setPop((p) => !p)}
          title={t.conn.title}
          aria-expanded={pop}
        >
          <span className="diamond text-[13px]" aria-hidden />
          <span className="text-[13px] font-semibold tracking-[-0.01em]">ClaudeSpace</span>
          <ConnDot />
        </button>
        {pop && <ConnPopover onClose={() => setPop(false)} />}
      </div>
      <div className="h-6 w-px self-center bg-line" />
      <div
        ref={stripRef}
        role="tablist"
        // empty space after the tabs moves the window; tabs and buttons are no-drag themselves
        className="drag ml-1 flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto overflow-y-hidden"
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
        <div className="no-drag flex h-[30px] shrink-0 items-center">
          <IconButton
            title={`${t.actions.newChat} (Ctrl+Shift+N)`}
            onClick={() => A.newChatHere()}
            disabled={!online}
          >
            <Plus size={15} aria-hidden />
          </IconButton>
          <DropdownMenu
            trigger={
              <button
                className="no-drag -ml-1 rounded-[6px] p-1 text-muted hover:bg-hover hover:text-fg"
                aria-label={t.actions.newTabMenu}
                title={t.actions.newTabMenu}
              >
                <ChevronDown size={12} aria-hidden />
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
      <div className="no-drag flex h-9 items-center gap-1 pl-2">
        <button
          type="button"
          title={`${t.actions.palette} (Ctrl+K, Ctrl+Shift+P)`}
          aria-label={t.actions.palette}
          onClick={() => useUi.getState().set({ palette: true })}
          className="no-drag flex h-7 items-center gap-2 rounded-[6px] border border-line-strong bg-base pl-2 pr-1 text-[12px] text-muted transition-colors duration-100 hover:border-control hover:text-fg active:bg-hover"
        >
          <Search size={13} aria-hidden />
          <span className="hidden lg:inline">{t.actions.paletteTrigger}</span>
          <Kbd>Ctrl K</Kbd>
        </button>
        <SplitMenu />
        <IconButton title={t.claudeScreen.open} onClick={() => openClaudeScreen()}>
          <BookText size={15} aria-hidden />
          <span className="ml-1 text-[12px]">Claude</span>
        </IconButton>
        <IconButton title={`${t.actions.rdp} (Ctrl+Alt+R)`} onClick={() => A.openRdp()}>
          <Monitor size={15} aria-hidden />
          <span className="ml-1 text-[12px]">RDP</span>
        </IconButton>
        <IconButton
          title={`${t.actions.settings} (Ctrl+,)`}
          onClick={() => useUi.getState().set({ settingsOpen: 'connection' })}
        >
          <SettingsIcon size={15} aria-hidden />
        </IconButton>
      </div>
    </header>
  );
}
