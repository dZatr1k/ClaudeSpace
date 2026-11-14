// Quick actions for the Claude of the active tab (interrupt, /compact, /clear, /model). The agent types a fixed
// command into the pane where that Claude runs; commands only when it is idle, since Enter at a permission prompt
// would approve it (checked here for the buttons and again in the agent).
import type { ClaudeProc } from '@shared/model';
import type { ClaudeModel } from '@shared/protocol';
import { agent } from '../bridge';
import { t } from '../i18n/ru';
import { primaryClaude } from './status';
import { useConn } from '../stores/conn';
import { useData } from '../stores/data';
import { activeTab } from '../stores/tabs';
import { useUi } from '../stores/ui';

export type ClaudeAction = 'interrupt' | 'compact' | 'clear';

/** the Claude the active tab shows (tmux tab of a session with Claude running), or null */
export function activeClaude(): ClaudeProc | null {
  const tab = activeTab();
  if (!tab || tab.kind !== 'tmux' || !tab.session || tab.term !== 'live') return null;
  if (useConn.getState().state.kind !== 'online') return null;
  const s = useData.getState().sessions.find((x) => x.name === tab.session);
  return s ? primaryClaude(s) : null;
}

export const canInterrupt = (c: ClaudeProc | null) => c?.status === 'busy' || c?.status === 'waiting';
export const canCommand = (c: ClaudeProc | null) => c?.status === 'idle';

async function send(params: Parameters<typeof agent<'claude_send'>>[1]): Promise<void> {
  try {
    await agent('claude_send', params);
  } catch (e) {
    useUi.getState().toast(t.claudeBar.failed((e as Error).message), 'error');
  }
}

export function claudeAction(action: ClaudeAction, c: ClaudeProc | null = activeClaude()): void {
  const ui = useUi.getState();
  if (!c) return ui.toast(t.claudeBar.noClaude, 'info');
  if (action === 'interrupt') return void send({ chatId: c.chatId, action });
  if (!canCommand(c)) return ui.toast(t.claudeBar.busy, 'info');
  if (action === 'clear') {
    ui.set({
      dialog: {
        kind: 'confirm',
        title: t.claudeBar.clearTitle,
        body: t.claudeBar.clearBody,
        confirm: t.claudeBar.clear,
        onConfirm: () => void send({ chatId: c.chatId, action }),
      },
    });
    return;
  }
  void send({ chatId: c.chatId, action });
}

export function setModel(model: ClaudeModel, c: ClaudeProc | null = activeClaude()): void {
  const ui = useUi.getState();
  if (!c) return ui.toast(t.claudeBar.noClaude, 'info');
  if (!canCommand(c)) return ui.toast(t.claudeBar.busy, 'info');
  void send({ chatId: c.chatId, action: 'model', model });
}
