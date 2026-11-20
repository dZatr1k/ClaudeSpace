import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useConn } from '../renderer/stores/conn';
import { useData } from '../renderer/stores/data';
import { App } from './App';
import { agent, hasBridge, invoke, on, setBridge } from './bridge';
import { devBridge } from './devBridge';
import { m } from './strings';
import { useApp, wireHistory } from './store';

const media = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const pref = useApp.getState().settings?.appearance.theme ?? 'system';
  const dark = pref === 'system' ? media.matches : pref === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (useApp.getState().dark !== dark) useApp.getState().set({ dark });
}

async function init() {
  // the Android service's bridge arrives in step 5; in the browser it is main's core under Vite
  if (import.meta.hot) {
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
    on('agent.event', ({ event, data }) => useData.getState().apply(event, data));
    let wasOnline = conn.kind === 'online';
    on('conn.state', (s) => {
      const online = s.kind === 'online';
      if (wasOnline && !online) useData.getState().markStale();
      if (!wasOnline && online && useConn.getState().everOnline)
        useApp.getState().toast(m.conn.restored, 'success', 2500);
      wasOnline = online;
      useConn.getState().set(s);
    });
    if (conn.kind === 'online')
      void agent('list_active').then(
        (r) => useData.getState().apply('active_changed', r),
        () => undefined,
      );
  }
  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void init();
