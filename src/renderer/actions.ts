// User-level operations (parity with cc, DESIGN §2): used by the sidebar, palette, menus, hotkeys and dialogs.
import type { Chat, Project, Session, Tab, TabKind } from '@shared/model';
import { AgentCallError, agent, invoke } from './bridge';
import { t } from './i18n/ru';
import { basename } from './lib/format';
import { newId } from './lib/ids';
import { sessionStatus } from './lib/status';
import {
  closeChannel,
  createHandle,
  disposeHandle,
  getHandle,
  openChannel,
} from './components/Terminal/controller';
import { useConn } from './stores/conn';
import { useData } from './stores/data';
import { activeTab, useTabs } from './stores/tabs';
import { useUi } from './stores/ui';

const toast = (...a: Parameters<ReturnType<typeof useUi.getState>['toast']>) => useUi.getState().toast(...a);

function requireOnline(): boolean {
  if (useConn.getState().state.kind === 'online') return true;
  toast(t.toasts.offlineAction, 'error');
  return false;
}

function errText(e: unknown): string {
  return e instanceof AgentCallError ? e.message : (e as Error)?.message || String(e);
}

function chatTitleOf(sessionName: string): { title: string; chatId: string | null; cwd: string } {
  const d = useData.getState();
  const s = d.sessions.find((x) => x.name === sessionName);
  const c = s?.claude[0];
  const chat = c ? d.chats[c.chatId] : undefined;
  const cwd = chat?.project ?? s?.path ?? d.hello?.home ?? '~';
  return { title: sessionName, chatId: c?.chatId ?? null, cwd };
}

// ---------------------------------------------------------------- tabs
export function openTab(partial: Omit<Tab, 'id' | 'term'> & { id?: string }, activate = true): string {
  const tab: Tab = { ...partial, id: partial.id ?? newId(), term: 'connecting' };
  createHandle(tab);
  useTabs.getState().add(tab, activate);
  // the TerminalView mounts on the next frame; open the channel after it has a size
  requestAnimationFrame(() => requestAnimationFrame(() => void openChannel(tab.id)));
  return tab.id;
}

export function focusTab(id: string): void {
  useTabs.getState().activate(id);
  requestAnimationFrame(() => getHandle(id)?.term.focus());
}

/** Open a tmux session in a tab (or switch to the tab that already shows it). */
export function openSession(name: string, chatId?: string | null): string {
  const existing = useTabs.getState().tabs.find((x) => x.kind === 'tmux' && x.session === name);
  if (existing) {
    focusTab(existing.id);
    if (existing.term !== 'live' && existing.term !== 'connecting') void openChannel(existing.id);
    return existing.id;
  }
  const info = chatTitleOf(name);
  return openTab({ kind: 'tmux', session: name, chatId: chatId ?? info.chatId, cwd: info.cwd, title: name });
}

export function closeTab(id: string): void {
  const tab = useTabs.getState().tabs.find((x) => x.id === id);
  if (!tab) return;
  closeChannel(id);
  disposeHandle(id);
  useTabs.getState().remove(id);
  const ui = useUi.getState();
  if (tab.kind === 'tmux' && tab.term !== 'ended' && ui.settings && !ui.settings.hints.tabCloseShown) {
    toast(t.term.closeHint, 'info', undefined, 7000);
    void invoke('settings.set', { hints: { tabCloseShown: true } }).then((s) =>
      useUi.getState().set({ settings: s }),
    );
  }
}

export function closeActiveTab(): void {
  const tab = activeTab();
  if (tab) closeTab(tab.id);
}

export function openTemp(kind: Exclude<TabKind, 'tmux'>, cwd: string, extra: Partial<Tab> = {}): void {
  if (!requireOnline()) return;
  const name = basename(cwd) || '~';
  const title =
    kind === 'shell'
      ? `shell ${name}`
      : kind === 'clone'
        ? `clone ${basename(extra.dest ?? '')}`
        : `${kind} ${name}`;
  openTab({ kind, session: null, chatId: null, cwd, title, ...extra });
}

// ---------------------------------------------------------------- chats
export async function newChat(cwd: string): Promise<void> {
  if (!requireOnline()) return;
  try {
    const r = await agent('new_session', { cwd });
    // the answer comes before active_changed: open the tab now
    openTab({ kind: 'tmux', session: r.session, chatId: null, cwd, title: r.session });
  } catch (e) {
    toast(errText(e), 'error');
  }
}

/** Main action of a chat: continue it, or go to the session where it already runs. */
export async function continueChat(chat: Chat): Promise<void> {
  if (chat.archived) return restoreChat(chat);
  if (chat.open) {
    if (!chat.open.session) {
      useUi.getState().set({ dialog: { kind: 'info', title: t.dialogs.outsideTmux(chat.open.pid ?? 0) } });
      return;
    }
    const id = openSession(chat.open.session, chat.id);
    if (chat.open.window && useConn.getState().state.kind === 'online')
      void agent('focus_window', { session: chat.open.session, window: chat.open.window }).catch(
        () => undefined,
      );
    focusTab(id);
    return;
  }
  if (!requireOnline()) return;
  if (!chat.project) {
    toast('Папка чата не найдена', 'error');
    return;
  }
  try {
    const r = await agent('new_session', { cwd: chat.project, resume: chat.id });
    openTab({ kind: 'tmux', session: r.session, chatId: chat.id, cwd: chat.project, title: r.session });
  } catch (e) {
    if (e instanceof AgentCallError && e.code === 'chat_open') {
      const d = e.payload.data as { session?: string | null; pid?: number } | undefined;
      if (d?.session) openSession(d.session, chat.id);
      else useUi.getState().set({ dialog: { kind: 'info', title: t.dialogs.outsideTmux(d?.pid ?? 0) } });
    } else toast(errText(e), 'error');
  }
}

export async function archiveChat(chat: Chat): Promise<void> {
  if (!requireOnline()) return;
  try {
    const r = await agent('archive_chat', { chatId: chat.id });
    useData.getState().apply('chats_changed', { upsert: [r.chat] });
    toast(
      t.toasts.archived(chat.title),
      'info',
      { label: t.toasts.undo, run: () => void restoreChat(r.chat) },
      5000,
    );
  } catch (e) {
    toast(e instanceof AgentCallError && e.code === 'chat_open' ? t.toasts.closeFirst : errText(e), 'error');
  }
}

export async function restoreChat(chat: Chat): Promise<void> {
  if (!requireOnline()) return;
  try {
    const r = await agent('restore_chat', { chatId: chat.id });
    useData.getState().apply('chats_changed', { upsert: [r.chat] });
    toast(t.toasts.restored(chat.title), 'success');
  } catch (e) {
    toast(errText(e), 'error');
  }
}

export function renameChat(chat: Chat): void {
  useUi.getState().set({
    dialog: {
      kind: 'prompt',
      title: t.dialogs.renameChat,
      hint: t.dialogs.renameChatHint,
      value: chat.titleSource === 'alias' ? chat.title : '',
      placeholder: chat.title,
      confirm: t.actions.save,
      onSubmit: async (v) => {
        try {
          const r = await agent('rename_chat', { chatId: chat.id, title: v.trim() || null });
          useData.getState().apply('chats_changed', { upsert: [r.chat] });
        } catch (e) {
          toast(errText(e), 'error');
        }
      },
    },
  });
}

// ---------------------------------------------------------------- sessions
export function renameSession(name: string): void {
  useUi.getState().set({
    dialog: {
      kind: 'prompt',
      title: t.dialogs.renameSession,
      value: name,
      confirm: t.actions.save,
      onSubmit: async (v) => {
        if (!v.trim() || v.trim() === name || !requireOnline()) return;
        try {
          const r = await agent('rename_session', { session: name, name: v.trim() });
          const { tabs, update } = useTabs.getState();
          for (const tab of tabs)
            if (tab.session === name) update(tab.id, { session: r.session, title: r.session });
        } catch (e) {
          toast(errText(e), 'error');
        }
      },
    },
  });
}

export function killSession(name: string): void {
  const s = useData.getState().sessions.find((x) => x.name === name);
  const busy = s ? sessionStatus(s).raw === 'busy' : false;
  useUi.getState().set({
    dialog: {
      kind: 'confirm',
      title: t.dialogs.killTitle(name),
      danger: busy ? t.dialogs.killBusy : undefined,
      confirm: t.actions.killSession,
      onConfirm: async () => {
        if (!requireOnline()) return;
        try {
          await agent('kill_session', { session: name });
          // the tab closes by itself: its channel ends and the session is gone
          for (const tab of useTabs.getState().tabs)
            if (tab.kind === 'tmux' && tab.session === name) closeTab(tab.id);
        } catch (e) {
          toast(errText(e), 'error');
        }
      },
    },
  });
}

export function detachSessionTab(name: string): void {
  for (const tab of useTabs.getState().tabs)
    if (tab.kind === 'tmux' && tab.session === name) closeTab(tab.id);
}

// ---------------------------------------------------------------- projects
/** Main action of a project: go to its live Claude session, or start a new chat. */
export function projectMain(p: Project): void {
  if (p.liveSession) openSession(p.liveSession);
  else void newChat(p.path);
}

export function openVsCode(path: string): void {
  void invoke('launch.vscode', { path }).then((r) => {
    if (!r.ok) toast(r.error ?? 'VS Code', 'error');
  });
}

export function openRdp(): void {
  void invoke('launch.rdp').then((r) => {
    if (r.ok) toast(t.toasts.rdpStart);
    else if (r.notConfigured)
      toast(
        t.toasts.rdpNotConfigured,
        'info',
        { label: t.toasts.configure, run: () => useUi.getState().set({ settingsOpen: 'integrations' }) },
        8000,
      );
    else toast(r.error ?? 'RDP', 'error', undefined, 6000);
  });
}

export async function createProject(path: string, gitInit: boolean): Promise<Project | null> {
  if (!requireOnline()) return null;
  try {
    const r = await agent('create_project', { path, gitInit });
    toast(t.toasts.created(r.project.name), 'success');
    return r.project;
  } catch (e) {
    toast(errText(e), 'error');
    return null;
  }
}

export function cloneRepo(url: string, dest: string): void {
  openTemp('clone', dest, { url, dest });
}

// ---------------------------------------------------------------- context
/** Folder of the active tab (for Ctrl+Shift+N/S/G); null if no tab. */
export function activeCwd(): string | null {
  const tab = activeTab();
  if (!tab) return null;
  if (tab.kind === 'tmux' && tab.session) {
    const d = useData.getState();
    const s = d.sessions.find((x) => x.name === tab.session);
    const c = s?.claude[0];
    const chat = c ? d.chats[c.chatId] : undefined;
    return chat?.project ?? s?.path ?? tab.cwd;
  }
  return tab.cwd;
}

export function newChatHere(): void {
  const cwd = activeCwd();
  if (cwd) void newChat(cwd);
  else useUi.getState().set({ dialog: { kind: 'newChat' } });
}

export function homeDir(): string {
  return useData.getState().hello?.home ?? '~';
}

export async function resync(): Promise<void> {
  if (!requireOnline()) return;
  try {
    await agent('resync');
  } catch (e) {
    toast(errText(e), 'error');
  }
}

export function copyText(text: string): void {
  void invoke('clipboard.write', { text }).then(() => toast(t.toasts.copied, 'success', undefined, 1500));
}

export function sessionByName(name: string): Session | undefined {
  return useData.getState().sessions.find((s) => s.name === name);
}

/** Show a chat in the sidebar «Чаты» list (filters cleared so the row is visible) and select it. */
export function showChatInList(chatId: string): void {
  const ui = useUi.getState();
  const chat = useData.getState().chats[chatId];
  ui.setLayout({ sidebarOpen: true, sidebarTab: chat?.archived ? 'archive' : 'chats' });
  ui.set({ filter: '', projectFilter: null });
  ui.setSelection({ kind: 'chat', id: chatId });
}
