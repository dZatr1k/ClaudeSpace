// One registry of app actions: the palette, menus and hotkeys take them from here.
import { defaultSettings } from '@shared/settings';
import { invoke } from './bridge';
import { t } from './i18n/ru';
import { basename } from './lib/format';
import type { AppCommandId } from './keymap';
import { HOTKEY_LABELS } from './keymap';
import * as A from './actions';
import { applyOptionsToAll, getHandle } from './components/Terminal/controller';
import { useConn } from './stores/conn';
import { activeTab, nextTabId, useTabs } from './stores/tabs';
import { useUi } from './stores/ui';

export interface Command {
  id: string;
  title: string;
  hotkey?: string;
  needsVm?: boolean;
  when?: () => boolean;
  run: () => void;
}

const ui = () => useUi.getState();

/** Ctrl+= / Ctrl+- / Ctrl+0 change the saved terminal font size, so the chosen size survives a restart. */
function setFont(delta: number | null) {
  const s = ui().settings;
  if (!s) return;
  const def = defaultSettings(ui().appInfo?.platform).terminal.fontSize;
  const size = delta === null ? def : Math.max(8, Math.min(28, s.terminal.fontSize + delta));
  if (size === s.terminal.fontSize) return;
  ui().set({ settings: { ...s, terminal: { ...s.terminal, fontSize: size } }, fontDelta: 0 });
  applyOptionsToAll();
  ui().toast(t.settings.fontSizeNow(size), 'info');
  void invoke('settings.set', { terminal: { fontSize: size } }).then(
    (next) => ui().set({ settings: next }),
    () => undefined,
  );
}

function focusSidebar() {
  const el = document.querySelector<HTMLElement>('[data-sidebar-focus]');
  const inSidebar = document.activeElement?.closest('[data-sidebar]');
  if (inSidebar) {
    const tab = activeTab();
    if (tab) getHandle(tab.id)?.term.focus();
  } else el?.focus();
}

function sidebarTab(tab: 'projects' | 'chats' | 'archive') {
  ui().setLayout({ sidebarTab: tab, sidebarOpen: true });
  ui().set({ projectFilter: null });
  requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-filter]')?.focus());
}

export async function pasteToActive(): Promise<void> {
  const tab = activeTab();
  const h = tab ? getHandle(tab.id) : undefined;
  if (!tab || !h) return;
  const text = await invoke('clipboard.read');
  if (!text) return;
  const lines = text.split(/\r\n|\r|\n/).length;
  const warn = ui().settings?.terminal.warnMultilinePaste ?? true;
  if (warn && lines > 5) {
    ui().set({ dialog: { kind: 'paste', text, onConfirm: () => h.term.paste(text) } });
  } else h.term.paste(text);
}

export function copyFromActive(): boolean {
  const tab = activeTab();
  const h = tab ? getHandle(tab.id) : undefined;
  if (!h || !h.term.hasSelection()) return false;
  void invoke('clipboard.write', { text: h.term.getSelection() });
  h.term.clearSelection();
  return true;
}

export function findInActive(): void {
  const tab = activeTab();
  if (!tab) return;
  if (tab.kind === 'tmux') {
    ui().toast(t.term.tmuxFindHint, 'info', undefined, 6000);
    return;
  }
  ui().set({
    dialog: {
      kind: 'prompt',
      title: t.actions.find,
      value: '',
      confirm: t.actions.find,
      onSubmit: (q) => {
        const h = getHandle(tab.id);
        if (q && h) h.search.findNext(q);
      },
    },
  });
}

export function runAppCommand(id: AppCommandId): void {
  const online = useConn.getState().state.kind === 'online';
  if (id.startsWith('tab.goto.')) {
    const n = Number(id.slice('tab.goto.'.length));
    const tab = useTabs.getState().tabs[n - 1];
    if (tab) A.focusTab(tab.id);
    return;
  }
  switch (id) {
    case 'palette':
      ui().set({ palette: true });
      return;
    case 'search.chats':
      ui().set({ chatSearch: ui().filter.trim() });
      return;
    case 'tab.next':
    case 'tab.prev': {
      const nid = nextTabId(id === 'tab.next' ? 1 : -1);
      if (nid) A.focusTab(nid);
      return;
    }
    case 'tab.last': {
      const tabs = useTabs.getState().tabs;
      const last = tabs[tabs.length - 1];
      if (last) A.focusTab(last.id);
      return;
    }
    case 'chat.newHere':
      A.newChatHere();
      return;
    case 'chat.newDialog':
      ui().set({ dialog: { kind: 'newChat' } });
      return;
    case 'tab.close':
      A.closeActiveTab();
      return;
    case 'shell.here':
      A.openTemp('shell', A.activeCwd() ?? A.homeDir());
      return;
    case 'lazygit.here':
      A.openTemp('lazygit', A.activeCwd() ?? A.homeDir());
      return;
    case 'sidebar.toggle':
      ui().setLayout({ sidebarOpen: !ui().layout.sidebarOpen });
      return;
    case 'right.toggle':
      ui().setLayout({ rightOpen: !ui().layout.rightOpen });
      return;
    case 'sidebar.focus':
      focusSidebar();
      return;
    case 'sidebar.projects':
      sidebarTab('projects');
      return;
    case 'sidebar.chats':
      sidebarTab('chats');
      return;
    case 'sidebar.archive':
      sidebarTab('archive');
      return;
    case 'term.find':
      findInActive();
      return;
    case 'term.copy':
      copyFromActive();
      return;
    case 'term.paste':
      void pasteToActive();
      return;
    case 'font.bigger':
      setFont(1);
      return;
    case 'font.smaller':
      setFont(-1);
      return;
    case 'font.reset':
      setFont(null);
      return;
    case 'settings':
      ui().set({ settingsOpen: 'connection' });
      return;
    case 'system.usage':
      ui().set({ system: 'usage' });
      return;
    case 'rdp':
      A.openRdp();
      return;
    case 'resync':
      if (online) void A.resync();
      else void invoke('conn.retryNow');
      return;
    case 'fullscreen':
      void invoke('app.toggleFullscreen');
      return;
    case 'devtools':
      void invoke('app.toggleDevTools');
      return;
  }
}

/** Global actions for the palette (context-dependent titles). */
export function getCommands(): Command[] {
  const cwd = A.activeCwd();
  const here = cwd ? basename(cwd) : null;
  const dev = !!ui().appInfo?.dev;
  const hk = (id: AppCommandId) => HOTKEY_LABELS[id];
  const list: Command[] = [
    {
      id: 'chat.newDialog',
      title: t.actions.newChatDots,
      hotkey: hk('chat.newDialog'),
      needsVm: true,
      run: () => runAppCommand('chat.newDialog'),
    },
    ...(here
      ? [
          {
            id: 'chat.newHere',
            title: t.actions.newChatIn(here),
            hotkey: hk('chat.newHere'),
            needsVm: true,
            run: () => runAppCommand('chat.newHere'),
          },
          {
            id: 'shell.here',
            title: t.actions.shellIn(here),
            hotkey: hk('shell.here'),
            needsVm: true,
            run: () => runAppCommand('shell.here'),
          },
          {
            id: 'lazygit.here',
            title: t.actions.lazygitIn(here),
            hotkey: hk('lazygit.here'),
            needsVm: true,
            run: () => runAppCommand('lazygit.here'),
          },
          { id: 'vscode.here', title: `${t.actions.vscode}: «${here}»`, run: () => cwd && A.openVsCode(cwd) },
        ]
      : []),
    {
      id: 'shell.home',
      title: t.actions.shellHome,
      needsVm: true,
      run: () => A.openTemp('shell', A.homeDir()),
    },
    {
      id: 'yazi.home',
      title: `${t.actions.yazi} (~)`,
      needsVm: true,
      run: () => A.openTemp('yazi', A.homeDir()),
    },
    {
      id: 'project.create',
      title: t.actions.createProject,
      needsVm: true,
      run: () => ui().set({ dialog: { kind: 'createProject' } }),
    },
    {
      id: 'project.clone',
      title: t.actions.clone,
      needsVm: true,
      run: () => ui().set({ dialog: { kind: 'clone' } }),
    },
    {
      id: 'search.chats',
      title: t.search.title,
      hotkey: hk('search.chats'),
      needsVm: true,
      run: () => runAppCommand('search.chats'),
    },
    {
      id: 'settings.sudo',
      title: `${t.settings.title}: ${t.settings.sudo}`,
      run: () => ui().set({ settingsOpen: 'sudo' }),
    },
    { id: 'rdp', title: t.actions.rdp, hotkey: hk('rdp'), run: () => runAppCommand('rdp') },
    {
      id: 'system.usage',
      title: `${t.actions.system}: ${t.actions.usage}`,
      hotkey: hk('system.usage'),
      run: () => ui().set({ system: 'usage' }),
    },
    {
      id: 'system.doctor',
      title: `${t.actions.system}: ${t.actions.doctor}`,
      run: () => ui().set({ system: 'doctor' }),
    },
    {
      id: 'system.resources',
      title: `${t.actions.system}: ${t.actions.resources}`,
      run: () => ui().set({ system: 'resources' }),
    },
    {
      id: 'settings',
      title: t.actions.settings,
      hotkey: hk('settings'),
      run: () => runAppCommand('settings'),
    },
    { id: 'resync', title: t.actions.resync, hotkey: hk('resync'), run: () => runAppCommand('resync') },
    {
      id: 'sidebar.toggle',
      title: t.actions.toggleSidebar,
      hotkey: hk('sidebar.toggle'),
      run: () => runAppCommand('sidebar.toggle'),
    },
    {
      id: 'right.toggle',
      title: t.actions.toggleRight,
      hotkey: hk('right.toggle'),
      run: () => runAppCommand('right.toggle'),
    },
    {
      id: 'tab.close',
      title: t.actions.closeTab,
      hotkey: hk('tab.close'),
      when: () => !!activeTab(),
      run: () => runAppCommand('tab.close'),
    },
    {
      id: 'term.find',
      title: t.actions.find,
      hotkey: hk('term.find'),
      when: () => !!activeTab(),
      run: () => runAppCommand('term.find'),
    },
    {
      id: 'font.bigger',
      title: t.actions.fontBigger,
      hotkey: hk('font.bigger'),
      run: () => runAppCommand('font.bigger'),
    },
    {
      id: 'font.smaller',
      title: t.actions.fontSmaller,
      hotkey: hk('font.smaller'),
      run: () => runAppCommand('font.smaller'),
    },
    {
      id: 'font.reset',
      title: t.actions.fontReset,
      hotkey: hk('font.reset'),
      run: () => runAppCommand('font.reset'),
    },
    {
      id: 'fullscreen',
      title: t.actions.fullscreen,
      hotkey: hk('fullscreen'),
      run: () => runAppCommand('fullscreen'),
    },
    { id: 'conn.reconnect', title: t.conn.reconnect, run: () => void invoke('conn.retryNow') },
  ];
  if (dev) {
    list.push(
      { id: 'debug.drop', title: t.conn.debugDrop, run: () => void invoke('conn.debugDrop') },
      { id: 'debug.freeze', title: t.conn.debugFreeze, run: () => void invoke('conn.debugFreeze') },
      { id: 'devtools', title: t.actions.devtools, hotkey: 'F12', run: () => runAppCommand('devtools') },
    );
  }
  return list.filter((c) => !c.when || c.when());
}
