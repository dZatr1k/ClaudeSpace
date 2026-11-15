import { CircleAlert, CircleCheck, CircleStop, ImagePlus, LoaderCircle, Unplug, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { Tab } from '@shared/model';
import * as A from '../../actions';
import { invoke } from '../../bridge';
import { copyFromActive, findInActive, pasteToActive, runAppCommand } from '../../commands';
import { t } from '../../i18n/ru';
import { appShortcut, terminalKey } from '../../keymap';
import { useConn } from '../../stores/conn';
import { useData } from '../../stores/data';
import { attachDroppedFiles } from '../../lib/images';
import { useTabs } from '../../stores/tabs';
import { paneRect } from '../../lib/panes';
import { useTabInfo } from '../../lib/tabInfo';
import { useUi } from '../../stores/ui';
import { Button } from '../ui/Button';
import { StatusIcon } from '../ui/StatusIcon';
import { ContextMenu } from '../ui/Menu';
import { createHandle, getHandle, mountHandle, openChannel, safeFit, writeToTab } from './controller';

/** A state card over the terminal: icon (shape carries the state), title, one line of why, actions. */
function Overlay({
  children,
  dim = true,
  icon,
  title,
  hint,
}: {
  children?: React.ReactNode;
  dim?: boolean;
  icon?: React.ReactNode;
  title: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className={`absolute inset-0 z-10 flex items-center justify-center p-6 ${dim ? 'bg-base/60' : ''}`}>
      <div
        role="status"
        className="anim-rise flex w-[380px] max-w-full flex-col items-center gap-2 rounded-[10px] border border-line-strong bg-elevated px-6 py-5 text-center shadow-modal"
      >
        {icon && <div className="mb-1">{icon}</div>}
        <div className="text-[14px] font-semibold">{title}</div>
        {hint && <div className="text-[12px] leading-relaxed text-muted selectable">{hint}</div>}
        {children && <div className="mt-2 flex flex-wrap justify-center gap-2">{children}</div>}
      </div>
    </div>
  );
}

function useCountdown(target: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!target) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [target]);
  return target ? Math.max(0, Math.ceil((target - now) / 1000)) : 0;
}

function TermOverlay({ tab }: { tab: Tab }) {
  const conn = useConn((c) => c.state);
  const chats = useData((d) => d.chats);
  const retryAt = conn.kind === 'offline' ? conn.retryAt : null;
  const left = useCountdown(retryAt);
  const name = tab.session ?? tab.title;
  if (conn.kind !== 'online' || tab.term === 'offline') {
    return (
      <Overlay
        icon={<WifiOff size={22} className="text-st-error" aria-hidden />}
        title={t.term.offline}
        hint={
          <>
            {conn.kind === 'offline' && (
              <span className="tnum block font-medium text-fg">{t.conn.retryIn(left)}</span>
            )}
            {conn.kind === 'connecting' && (
              <span className="block font-medium text-fg">{t.conn.connecting}</span>
            )}
            {t.term.offlineHint}
          </>
        }
      >
        <Button small onClick={() => void invoke('conn.retryNow')}>
          {t.conn.now}
        </Button>
      </Overlay>
    );
  }
  switch (tab.term) {
    case 'connecting':
      return (
        <Overlay
          dim={false}
          icon={<LoaderCircle size={20} className="anim-spin text-st-busy" aria-hidden />}
          title={t.term.connecting(name)}
        />
      );
    case 'error':
      return (
        <Overlay
          icon={<CircleAlert size={22} className="text-st-error" aria-hidden />}
          title={t.term.error}
          hint={tab.error}
        >
          <Button small variant="primary" onClick={() => void openChannel(tab.id)}>
            {t.actions.retry}
          </Button>
          <Button small onClick={() => A.closeTab(tab.id)}>
            {t.actions.closeTab}
          </Button>
        </Overlay>
      );
    case 'detached':
      return (
        <Overlay
          icon={<Unplug size={22} className="text-muted" aria-hidden />}
          title={t.term.detached(name)}
          hint={t.term.detachedHint}
        >
          <Button small variant="primary" onClick={() => void openChannel(tab.id)}>
            {t.actions.reconnectTab}
          </Button>
          <Button small onClick={() => A.closeTab(tab.id)}>
            {t.actions.closeTab}
          </Button>
        </Overlay>
      );
    case 'ended': {
      const chat = tab.chatId ? chats[tab.chatId] : undefined;
      return (
        <Overlay
          icon={<CircleStop size={22} className="text-st-error" aria-hidden />}
          title={t.term.ended(name)}
          hint={t.term.endedHint}
        >
          <>
            {chat && (
              <Button
                small
                variant="primary"
                onClick={() => {
                  A.closeTab(tab.id);
                  void A.continueChat(chat);
                }}
              >
                {t.actions.continueChat}
              </Button>
            )}
            <Button small onClick={() => A.closeTab(tab.id)}>
              {t.actions.closeTab}
            </Button>
          </>
        </Overlay>
      );
    }
    case 'exited':
      if (tab.kind === 'clone') {
        const ok = tab.exitCode === 0;
        return (
          <Overlay
            dim={false}
            icon={
              ok ? (
                <CircleCheck size={22} className="text-st-idle" aria-hidden />
              ) : (
                <CircleAlert size={22} className="text-st-error" aria-hidden />
              )
            }
            title={ok ? t.term.cloneDone : t.term.cloneFailed(tab.exitCode ?? null)}
          >
            <>
              {ok && tab.dest && (
                <Button
                  small
                  variant="primary"
                  onClick={() => {
                    A.closeTab(tab.id);
                    void A.newChat(tab.dest as string);
                  }}
                >
                  {t.actions.newChatIn(tab.dest.split('/').pop() ?? tab.dest)}
                </Button>
              )}
              <Button small onClick={() => A.closeTab(tab.id)}>
                {t.actions.closeTab}
              </Button>
            </>
          </Overlay>
        );
      }
      return (
        <Overlay
          dim={false}
          icon={<CircleStop size={22} className="text-muted" aria-hidden />}
          title={t.term.exited(tab.exitCode ?? null)}
          hint={tab.error}
        >
          <Button small variant="primary" onClick={() => void openChannel(tab.id)}>
            {t.actions.retry}
          </Button>
          <Button small onClick={() => A.closeTab(tab.id)}>
            {t.actions.closeTab}
          </Button>
        </Overlay>
      );
    default:
      return null;
  }
}

/** split view: which chat a pane shows (the tab strip is far away once there are four panes) */
function PaneHeader({ tab, active }: { tab: Tab; active: boolean }) {
  const info = useTabInfo(tab);
  return (
    <div
      className={`flex h-6 shrink-0 items-center gap-1.5 border-b border-line px-2 text-[12px] ${active ? 'bg-surface text-fg' : 'text-muted'}`}
      title={[info.chatTitle, info.path].filter(Boolean).join('\n')}
    >
      {tab.kind === 'tmux' ? <StatusIcon status={info.status} size={12} /> : null}
      <span className={`truncate ${active ? 'font-medium' : ''}`}>{info.title}</span>
      {info.chatTitle && info.chatTitle !== info.title && (
        <span className="min-w-0 truncate text-faint">· {info.chatTitle}</span>
      )}
    </div>
  );
}

/** pane: where this tab sits in split view (lib/panes.ts), null = not on screen; active = the focused one */
export function TerminalView({
  tab,
  active,
  pane,
}: {
  tab: Tab;
  active: boolean;
  pane: { index: number; rect: ReturnType<typeof paneRect>; split: boolean } | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const settings = useUi((u) => u.settings);
  const online = useConn((c) => c.state.kind === 'online');
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0); // dragenter/leave fire for every child

  useEffect(() => {
    const h = createHandle(tab);
    if (hostRef.current) mountHandle(h, hostRef.current);
    const dev = !!useUi.getState().appInfo?.dev;
    h.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') {
        // swallow keyup/keypress of keys we handled on keydown
        return !(appShortcut(e, true, dev) || terminalKey(e, termOpts()));
      }
      const cmd = appShortcut(e, true, dev);
      if (cmd) {
        e.preventDefault();
        runAppCommand(cmd);
        return false;
      }
      const action = terminalKey(e, termOpts());
      if (action === 'copy-or-sigint') {
        if (copyFromActive()) {
          e.preventDefault();
          return false;
        }
        return true; // ^C to the terminal
      }
      if (action === 'paste') {
        e.preventDefault();
        void pasteToActive();
        return false;
      }
      if (action === 'newline') {
        e.preventDefault();
        writeToTab(tab.id, '\x1b\r'); // Meta+Enter: newline in Claude Code's input
        return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  // fit on container resize (window, panels) — debounced; xterm onResize sends setWindow to the VM
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let timer: number | null = null;
    const ro = new ResizeObserver(() => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const h = getHandle(tab.id);
        if (h) safeFit(h);
      }, 50);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (timer) window.clearTimeout(timer);
    };
  }, [tab.id]);

  useEffect(() => {
    if (!active) return;
    const h = getHandle(tab.id);
    if (!h) return;
    requestAnimationFrame(() => {
      safeFit(h);
      h.term.focus();
      if (tab.term === 'live')
        void invoke('term.resize', { tabId: tab.id, cols: h.term.cols, rows: h.term.rows });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const isShell = tab.kind !== 'tmux';
  const menu = () => [
    { label: t.actions.copy, hint: 'Ctrl+Shift+C', run: () => copyFromActive() },
    { label: t.actions.paste, hint: 'Ctrl+Shift+V', run: () => void pasteToActive() },
    { label: t.actions.selectAll, run: () => getHandle(tab.id)?.term.selectAll() },
    ...(isShell ? [{ label: t.actions.clear, run: () => getHandle(tab.id)?.term.clear() }] : []),
    { label: t.actions.find, hint: 'Ctrl+Shift+F', run: () => findInActive() },
  ];
  const dimmed = !online || tab.term === 'offline';
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');
  return (
    <div
      className={`absolute flex flex-col ${pane ? '' : 'invisible pointer-events-none'} ${pane?.split && pane.rect.left > 0 ? 'border-l border-line' : ''} ${pane?.split && pane.rect.top > 0 ? 'border-t border-line' : ''}`}
      style={
        pane
          ? {
              left: `${pane.rect.left}%`,
              top: `${pane.rect.top}%`,
              width: `${pane.rect.width}%`,
              height: `${pane.rect.height}%`,
            }
          : { inset: 0 }
      }
      data-pane={pane?.index}
      onMouseDownCapture={() => {
        if (pane?.split && !active) useTabs.getState().focusPane(pane.index);
      }}
      data-terminal={tab.id}
      data-term-state={tab.term}
      onDragEnter={(e) => {
        if (!hasFiles(e) || dimmed) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e) || dimmed) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        if (--dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(e) => {
        dragDepth.current = 0;
        setDragging(false);
        if (!hasFiles(e) || dimmed) return;
        e.preventDefault();
        void attachDroppedFiles(tab.id, Array.from(e.dataTransfer.files));
      }}
      onWheel={(e) => {
        if (e.ctrlKey) {
          e.preventDefault();
          runAppCommand(e.deltaY < 0 ? 'font.bigger' : 'font.smaller');
        }
      }}
    >
      {pane?.split && <PaneHeader tab={tab} active={active} />}
      <ContextMenu items={menu}>
        <div
          ref={hostRef}
          style={{ opacity: dimmed ? 0.45 : 1, background: 'var(--bg-base)' }}
          className="min-h-0 w-full flex-1 overflow-hidden transition-opacity duration-200"
        />
      </ContextMenu>
      {pane && <TermOverlay tab={tab} />}
      {pane?.split && active && (
        <div
          className="pointer-events-none absolute inset-0 z-10 shadow-[inset_0_0_0_1px_var(--accent)]"
          aria-hidden
        />
      )}
      {dragging && (
        <div
          className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-1 rounded-[10px] border-2 border-dashed border-accent bg-base/80"
          data-testid="image-drop"
        >
          <ImagePlus size={24} className="text-accent-text" aria-hidden />
          <div className="text-[14px] font-semibold">{t.images.drop}</div>
          <div className="text-[12px] text-muted">{t.images.dropHint}</div>
        </div>
      )}
      {settings && null}
    </div>
  );
}

function termOpts() {
  const s = useUi.getState().settings?.terminal;
  return { ctrlCCopies: s?.ctrlCCopies ?? true, ctrlVPastes: s?.ctrlVPastes ?? true };
}

export function TerminalStack() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const split = useTabs((s) => s.split);
  const panes = useTabs((s) => s.panes);
  const focus = useTabs((s) => s.focus);
  const isSplit = split !== 'single';
  const paneOf = (id: string) => {
    const index = isSplit ? panes.indexOf(id) : id === activeId ? 0 : -1;
    return index < 0 ? null : { index, rect: paneRect(split, index), split: isSplit };
  };
  return (
    <div className="relative h-full w-full bg-base">
      {tabs.map((tab) => (
        <TerminalView key={tab.id} tab={tab} active={tab.id === activeId} pane={paneOf(tab.id)} />
      ))}
      {isSplit &&
        panes.map((id, i) => {
          if (id) return null;
          const r = paneRect(split, i);
          return (
            <button
              key={`empty-${i}`}
              type="button"
              data-empty-pane={i}
              className={`absolute flex flex-col items-center justify-center gap-1 px-6 text-center text-[13px] text-muted ${r.left > 0 ? 'border-l border-line' : ''} ${r.top > 0 ? 'border-t border-line' : ''} ${focus === i ? 'shadow-[inset_0_0_0_1px_var(--accent)]' : ''}`}
              style={{ left: `${r.left}%`, top: `${r.top}%`, width: `${r.width}%`, height: `${r.height}%` }}
              onClick={() => useTabs.getState().focusPane(i)}
            >
              <span className="font-medium text-fg">{t.split.emptyTitle}</span>
              <span className="max-w-[320px] text-[12px] leading-relaxed">{t.split.emptyHint}</span>
            </button>
          );
        })}
    </div>
  );
}
