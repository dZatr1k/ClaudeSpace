// What a tab is called and what state it is in: shared by the tab strip and the pane headers of split view.
import type { Tab, UiStatus } from '@shared/model';
import { useConn } from '../stores/conn';
import { useData } from '../stores/data';
import { sessionStatus } from './status';

export function tabStatus(
  tab: Tab,
  sessionsStatus: Map<string, { ui: UiStatus; raw: string | null }>,
  online: boolean,
): UiStatus {
  if (!online || tab.term === 'offline') return 'offline';
  if (tab.term === 'ended' || tab.term === 'error') return 'error';
  if (tab.kind !== 'tmux') return 'none';
  return (tab.session && sessionsStatus.get(tab.session)?.ui) || 'none';
}

/** title: the project folder name when Claude runs in the tab, else the tab's own title; tip: chat, folder, state */
export function useTabInfo(tab: Tab): {
  title: string;
  chatTitle: string | null;
  path: string | null;
  status: UiStatus;
} {
  const sessions = useData((d) => d.sessions);
  const chats = useData((d) => d.chats);
  const online = useConn((c) => c.state.kind === 'online');
  const s = tab.session ? sessions.find((x) => x.name === tab.session) : undefined;
  const chat = s?.claude[0] ? chats[s.claude[0].chatId] : tab.chatId ? chats[tab.chatId] : undefined;
  const status = tabStatus(tab, new Map(s ? [[s.name, sessionStatus(s)]] : []), online);
  return {
    title: chat?.project ? chat.project.split('/').pop() || tab.title : tab.title,
    chatTitle: chat?.title ?? null,
    path: s?.path ?? tab.cwd ?? null,
    status,
  };
}
