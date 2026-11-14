import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Tab, Workspace } from '@shared/model';
import { App } from './App';
import { agent, invoke, on } from './bridge';
import { t } from './i18n/ru';
import { formatDuration } from './lib/format';
import {
  applyOptionsToAll,
  createHandle,
  loadTermFont,
  remeasureAll,
  wireTerminals,
} from './components/Terminal/controller';
import { wireNotifications } from './notifier';
import { wireAskpass } from './askpass';
import { wireSearch } from './lib/chatSearch';
import { useConn } from './stores/conn';
import { usePcLink } from './stores/pclink';
import { usePorts } from './stores/ports';
import { useUpdate } from './stores/update';
import { newProjectPorts } from './lib/portsNotify';
import { openVmPort } from './lib/ports';
import type { VmPort } from '@shared/protocol';
import { useData } from './stores/data';
import { useTabs } from './stores/tabs';
import { defaultLayout, useUi } from './stores/ui';

function applyTheme() {
  const s = useUi.getState().settings;
  const pref = s?.appearance.theme ?? 'system';
  const dark =
    pref === 'system' ? window.matchMedia('(prefers-color-scheme: dark)').matches : pref === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.setProperty('--ui-font', `${s?.appearance.uiFontSize ?? 13}px`);
  if (useUi.getState().dark !== dark) {
    useUi.getState().set({ dark });
    applyOptionsToAll();
  }
}

// a file dropped outside a terminal must not make Chromium open it (terminals handle their own drops)
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

async function init() {
  const [settings, appInfo, ws, snap, conn, pcl] = await Promise.all([
    invoke('settings.get'),
    invoke('app.info'),
    invoke('workspace.get'),
    invoke('snapshot.get'),
    invoke('conn.state'),
    invoke('pclink.state'),
  ]);
  usePcLink.getState().set(pcl);
  on('pclink.state', (s) => usePcLink.getState().set(s));
  usePorts.getState().set(await invoke('ports.state'));
  useUpdate.getState().set(await invoke('update.state'));
  on('update.state', (s) => useUpdate.getState().set(s));
  on('ports.state', (f) => usePorts.getState().set(f));
  // a new dev server in a project with an open session: offer to open it (BACKLOG 10)
  let lastPorts: VmPort[] | null = null;
  useData.subscribe((d, p) => {
    if (d.ports === p.ports) return;
    const fresh = newProjectPorts(lastPorts, d.ports, d.sessions);
    lastPorts = d.ports;
    if (!useUi.getState().settings?.ports.notifyNew) return;
    for (const x of fresh)
      useUi.getState().toast(
        t.ports.newPort(x.port, x.name ?? '?', x.project ?? ''),
        'info',
        {
          label: t.ports.open,
          run: () => void openVmPort(x.port),
        },
        12000,
      );
  });
  useConn.subscribe((c) => {
    if (c.state.kind !== 'online') lastPorts = null;
  });
  useUi.getState().set({ settings, appInfo });
  applyTheme();
  // terminals must be measured with the real font, not a fallback (see loadTermFont)
  await loadTermFont(settings.terminal.fontFamily, settings.terminal.fontSize);
  document.fonts.addEventListener('loadingdone', () => remeasureAll());
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  useData.getState().loadSnapshot(snap);
  useConn.getState().set(conn);
  wireTerminals();
  wireNotifications();
  wireAskpass();
  wireSearch();

  // restore layout + tmux tabs (DESIGN §4.1); temporary tabs are not restored
  if (ws) {
    useUi.getState().setLayout({ ...defaultLayout, ...ws.layout });
    if (settings.startup.restoreTabs) {
      const tabs: Tab[] = ws.tabs
        .filter((x) => x.kind === 'tmux' && x.session)
        .map((x) => ({ ...x, term: conn.kind === 'online' ? 'connecting' : 'offline' }));
      for (const tab of tabs) createHandle(tab);
      useTabs
        .getState()
        .setAll(tabs, tabs.some((x) => x.id === ws.activeTabId) ? ws.activeTabId : (tabs[0]?.id ?? null));
    }
  }

  if (conn.kind === 'online')
    void agent('list_active').then(
      (r) => useData.getState().apply('active_changed', r),
      () => undefined,
    );

  on('settings.changed', (s) => {
    useUi.getState().set({ settings: s });
    applyTheme();
    applyOptionsToAll();
  });
  on('theme.dark', () => applyTheme());
  on('agent.event', ({ event, data }) => useData.getState().apply(event, data));
  let lostAt: number | null = null;
  on('conn.state', (s) => {
    const prev = useConn.getState().state;
    useConn.getState().set(s);
    if (prev.kind === 'online' && s.kind !== 'online') lostAt = Date.now();
    if (s.kind === 'online' && lostAt) {
      useUi.getState().toast(t.conn.restored(formatDuration(Date.now() - lostAt)), 'success');
      lostAt = null;
    }
  });

  // usage for the status bar: on connect and every 5 minutes (agent caches ccusage for 60 s)
  const refreshUsage = () => {
    if (useConn.getState().state.kind !== 'online') return;
    agent('usage', {}).then(
      (u) => useData.getState().setUsage(u),
      () => undefined,
    );
  };
  useConn.subscribe((c, p) => {
    if (c.state.kind === 'online' && p.state.kind !== 'online') refreshUsage();
  });
  refreshUsage();
  setInterval(refreshUsage, 5 * 60_000);

  // persist workspace (debounced in main)
  const save = () => {
    const { tabs, activeId } = useTabs.getState();
    const w: Workspace = {
      version: 1,
      tabs: tabs
        .filter((x) => x.kind === 'tmux')
        .map(({ id, kind, session, chatId, cwd, title }) => ({ id, kind, session, chatId, cwd, title })),
      activeTabId: activeId,
      layout: useUi.getState().layout,
      window: null,
    };
    void invoke('workspace.save', w);
  };
  useTabs.subscribe(save);
  useUi.subscribe((s, p) => {
    if (s.layout !== p.layout) save();
  });

  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void init();
