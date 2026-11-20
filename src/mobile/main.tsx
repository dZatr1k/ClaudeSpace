import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useConn } from '../renderer/stores/conn';
import { useData } from '../renderer/stores/data';
import { App } from './App';
import type { TurnDone } from '@shared/protocol';
import { hasBridge, invoke, on, setBridge } from './bridge';
import { devBridge } from './devBridge';
import { nativeBridge } from './nativeBridge';
import { m } from './strings';
import { go, useApp, wireHistory } from './store';

const media = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const pref = useApp.getState().settings?.appearance.theme ?? 'system';
  const dark = pref === 'system' ? media.matches : pref === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (useApp.getState().dark !== dark) useApp.getState().set({ dark });
}

/**
 * A turn ended in another chat while the app is open: a toast that opens it. When the app is closed the service
 * posts an Android notification instead; for the chat on screen there is nothing to say.
 */
function turnToast(ev: TurnDone) {
  const screen = useApp.getState().screen;
  if (!ev.session || (screen.kind === 'chat' && screen.session === ev.session)) return;
  const path = (ev.chatId && useData.getState().chats[ev.chatId]?.project) || ev.cwd;
  const name = path?.split('/').filter(Boolean).pop() || ev.project || ev.session;
  const session = ev.session;
  useApp
    .getState()
    .toast(ev.kind === 'input' ? m.notify.input(name) : m.notify.done(name), 'info', 8000, () =>
      go({ kind: 'chat', session, chatId: ev.chatId }),
    );
}

async function init() {
  // in the APK: the app's service (Capacitor plugin); in the browser: main's core under Vite
  const native = nativeBridge();
  if (native) setBridge(native);
  else if (import.meta.hot) {
    const b = devBridge(import.meta.hot);
    setBridge(b);
    // dev: e2e and manual checks can show states the local transport never reaches
    (window as unknown as { csDev: typeof b }).csDev = b;
  }
  applyTheme();
  media.addEventListener('change', applyTheme);
  wireHistory();
  if (hasBridge()) {
    const [settings, key, conn] = await Promise.all([
      invoke('settings.get'),
      invoke('key.get'),
      invoke('conn.state'),
    ]);
    useApp.getState().set({ settings, key });
    applyTheme();
    useConn.getState().set(conn);
    on('settings.changed', (s) => {
      useApp.getState().set({ settings: s });
      applyTheme();
    });
    on('agent.event', ({ event, data }) => {
      useData.getState().apply(event, data);
      if (event === 'turn_done') turnToast(data as TurnDone);
    });
    on('notify.click', ({ session, chatId }) => go({ kind: 'chat', session, chatId }));
    let wasOnline = conn.kind === 'online';
    // Android asks for the notification permission once, when the app first gets through to the VM
    let asked = false;
    const askNotifications = () => {
      if (asked || !useApp.getState().settings?.notifications.background) return;
      asked = true;
      void invoke('notify.permission', { request: true }).catch(() => undefined);
    };
    if (wasOnline) askNotifications();
    on('conn.state', (s) => {
      const online = s.kind === 'online';
      if (online) askNotifications();
      if (wasOnline && !online) useData.getState().markStale();
      if (!wasOnline && online && useConn.getState().everOnline)
        useApp.getState().toast(m.conn.restored, 'success', 2500);
      wasOnline = online;
      useConn.getState().set(s);
    });
    // the core may have been online for a while (the service kept the connection): take its latest lists
    for (const e of await invoke('events.replay')) useData.getState().apply(e.event, e.data);
  }
  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void init();
