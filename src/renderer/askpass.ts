// sudo password prompts from the VM (BACKLOG 11): agent events -> queue (stores/askpass) -> AskpassDialog.
// The password goes from the dialog straight to main (IPC 'askpass.reply'); it is not kept anywhere in the renderer.
import type { AskpassDone, AskpassRequest } from '@shared/askpass';
import { invoke, on } from './bridge';
import { t } from './i18n/ru';
import { useAskpass } from './stores/askpass';
import { useConn } from './stores/conn';
import { useUi } from './stores/ui';

/** answer the first prompt in the queue (null = cancel); removes it at once, whatever the agent says */
export async function answerAskpass(id: string, password: string | null): Promise<void> {
  useAskpass.getState().remove(id);
  const r = await invoke('askpass.reply', { id, password });
  if (!r.ok && password !== null) useUi.getState().toast(t.askpass.failed(r.error ?? ''), 'error');
}

export function onAskpassEvent(event: string, data: unknown): void {
  if (event === 'askpass_request') useAskpass.getState().add(data as AskpassRequest);
  else if (event === 'askpass_done') {
    const d = data as AskpassDone;
    const had = useAskpass.getState().queue.some((x) => x.id === d.id);
    useAskpass.getState().remove(d.id);
    if (had && d.reason === 'timeout') useUi.getState().toast(t.askpass.expired, 'info');
  }
}

export function wireAskpass(): void {
  void invoke('askpass.pending').then((list) => {
    for (const r of list) useAskpass.getState().add(r);
  });
  on('agent.event', ({ event, data }) => onAskpassEvent(event, data));
  // the agent that waited for these is gone (or will be replaced): its prompts are over
  useConn.subscribe((c, p) => {
    if (c.state.kind !== 'online' && p.state.kind === 'online') useAskpass.getState().clear();
  });
}
