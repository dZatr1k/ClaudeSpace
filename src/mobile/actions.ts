// Opening chats from the phone: the same agent calls as the desktop (renderer/actions.ts), ending on the chat screen.
import type { Chat, Project, Session } from '@shared/model';
import { useConn } from '../renderer/stores/conn';
import { useData } from '../renderer/stores/data';
import { primaryClaude } from '../renderer/lib/status';
import { AgentCallError, agent } from './bridge';
import { m } from './strings';
import { go, useApp } from './store';

const toast = (text: string) => useApp.getState().toast(text, 'error', 6000);

function online(): boolean {
  if (useConn.getState().state.kind === 'online') return true;
  toast(m.home.offline);
  return false;
}

export function openSession(s: Session): void {
  go({ kind: 'chat', session: s.name, chatId: primaryClaude(s)?.chatId ?? null });
}

export async function continueChat(chat: Chat): Promise<void> {
  if (chat.open) {
    if (!chat.open.session) return toast(m.home.outsideTmux);
    return go({ kind: 'chat', session: chat.open.session, chatId: chat.id });
  }
  if (!online()) return;
  if (!chat.project) return toast(m.home.folderMissing);
  try {
    const r = await agent('new_session', { cwd: chat.project, resume: chat.id });
    go({ kind: 'chat', session: r.session, chatId: chat.id });
  } catch (e) {
    if (e instanceof AgentCallError && e.code === 'chat_open') {
      const d = e.payload.data as { session?: string | null } | undefined;
      if (d?.session) return go({ kind: 'chat', session: d.session, chatId: chat.id });
      return toast(m.home.outsideTmux);
    }
    toast(m.home.openFailed((e as Error).message));
  }
}

export async function newChat(p: Project): Promise<void> {
  useApp.getState().set({ sheet: null });
  if (!online()) return;
  try {
    const r = await agent('new_session', { cwd: p.path });
    go({ kind: 'chat', session: r.session, chatId: null });
  } catch (e) {
    toast(m.home.openFailed((e as Error).message));
  }
}

/** title for a session: the chat its Claude shows, else the session name */
export function sessionTitle(s: Session): string {
  const id = primaryClaude(s)?.chatId;
  return (id && useData.getState().chats[id]?.title) || s.name;
}
