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
import { useUi } from '../../stores/ui';
import { Button } from '../ui/Button';
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

export function TerminalView({ tab, active }: { tab: Tab; active: boolean }) {
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
      className={`absolute inset-0 ${active ? '' : 'invisible pointer-events-none'}`}
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
      <ContextMenu items={menu}>
        <div
          ref={hostRef}
          style={{ opacity: dimmed ? 0.45 : 1, background: 'var(--bg-base)' }}
          className="h-full w-full transition-opacity duration-200"
        />
      </ContextMenu>
      {active && <TermOverlay tab={tab} />}
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
  return (
    <div className="relative h-full w-full bg-base">
      {tabs.map((tab) => (
        <TerminalView key={tab.id} tab={tab} active={tab.id === activeId} />
      ))}
    </div>
  );
}
