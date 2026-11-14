import { LoaderCircle, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Tab } from '@shared/model';
import * as A from '../../actions';
import { invoke } from '../../bridge';
import { copyFromActive, findInActive, pasteToActive, runAppCommand } from '../../commands';
import { t } from '../../i18n/ru';
import { appShortcut, terminalKey } from '../../keymap';
import { useConn } from '../../stores/conn';
import { useData } from '../../stores/data';
import { useTabs } from '../../stores/tabs';
import { useUi } from '../../stores/ui';
import { Button } from '../ui/Button';
import { ContextMenu } from '../ui/Menu';
import { createHandle, getHandle, mountHandle, openChannel, safeFit, writeToTab } from './controller';

function Overlay({ children, dim = true }: { children: React.ReactNode; dim?: boolean }) {
  return (
    <div className={`absolute inset-0 z-10 flex items-center justify-center ${dim ? 'bg-base/50' : ''}`}>
      <div className="flex max-w-md flex-col items-center gap-3 rounded-[8px] border border-line-strong bg-elevated px-5 py-4 text-center shadow-float">
        {children}
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
      <Overlay>
        <WifiOff size={20} className="text-st-error" />
        <div className="font-medium">{t.term.offline}</div>
        {conn.kind === 'offline' && <div className="tnum text-[12px] text-muted">{t.conn.retryIn(left)}</div>}
        {conn.kind === 'connecting' && <div className="text-[12px] text-muted">{t.conn.connecting}</div>}
        <Button small onClick={() => void invoke('conn.retryNow')}>
          {t.conn.now}
        </Button>
      </Overlay>
    );
  }
  switch (tab.term) {
    case 'connecting':
      return (
        <Overlay dim={false}>
          <LoaderCircle size={18} className="anim-spin text-muted" />
          <div className="text-[13px]">{t.term.connecting(name)}</div>
        </Overlay>
      );
    case 'error':
      return (
        <Overlay>
          <div className="font-medium text-st-error">{t.term.error}</div>
          <div className="text-[12px] text-muted selectable">{tab.error}</div>
          <div className="flex gap-2">
            <Button small variant="primary" onClick={() => void openChannel(tab.id)}>
              {t.actions.retry}
            </Button>
            <Button small onClick={() => A.closeTab(tab.id)}>
              {t.actions.closeTab}
            </Button>
          </div>
        </Overlay>
      );
    case 'detached':
      return (
        <Overlay>
          <div className="font-medium">{t.term.detached(name)}</div>
          <div className="flex gap-2">
            <Button small variant="primary" onClick={() => void openChannel(tab.id)}>
              {t.actions.reconnectTab}
            </Button>
            <Button small onClick={() => A.closeTab(tab.id)}>
              {t.actions.closeTab}
            </Button>
          </div>
        </Overlay>
      );
    case 'ended': {
      const chat = tab.chatId ? chats[tab.chatId] : undefined;
      return (
        <Overlay>
          <div className="font-medium">{t.term.ended(name)}</div>
          <div className="flex gap-2">
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
          </div>
        </Overlay>
      );
    }
    case 'exited':
      if (tab.kind === 'clone') {
        const ok = tab.exitCode === 0;
        return (
          <Overlay dim={false}>
            <div className={`font-medium ${ok ? 'text-st-idle' : 'text-st-error'}`}>
              {ok ? t.term.cloneDone : t.term.cloneFailed(tab.exitCode ?? null)}
            </div>
            <div className="flex gap-2">
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
            </div>
          </Overlay>
        );
      }
      return (
        <Overlay dim={false}>
          <div className="font-medium">
            {tab.error
              ? `${t.term.exited(tab.exitCode ?? null)}: ${tab.error}`
              : t.term.exited(tab.exitCode ?? null)}
          </div>
          <div className="flex gap-2">
            <Button small variant="primary" onClick={() => void openChannel(tab.id)}>
              {t.actions.retry}
            </Button>
            <Button small onClick={() => A.closeTab(tab.id)}>
              {t.actions.closeTab}
            </Button>
          </div>
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
  return (
    <div
      className={`absolute inset-0 ${active ? '' : 'invisible pointer-events-none'}`}
      data-terminal={tab.id}
      data-term-state={tab.term}
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
          className="h-full w-full"
          style={{ opacity: dimmed ? 0.5 : 1, background: 'var(--bg-base)' }}
        />
      </ContextMenu>
      {active && <TermOverlay tab={tab} />}
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
