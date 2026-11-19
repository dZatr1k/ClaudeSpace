// Opening VM ports in the PC's browser (BACKLOG 10): forward first, then open; say so if the PC port differs.
import { parseLocalUrl } from '@shared/ports';
import type { PortOpenResult } from '@shared/ipc';
import { invoke, on } from '../bridge';
import { t } from '../i18n/ru';
import { useUi } from '../stores/ui';

function report(r: PortOpenResult, opened: boolean): void {
  const ui = useUi.getState();
  if (!r.ok) {
    ui.toast(t.ports.failed(r.error), 'error', undefined, 8000);
    return;
  }
  if (r.localPort !== r.vmPort) ui.toast(t.ports.differs(r.vmPort, r.localPort), 'info', undefined, 10000);
  else if (!opened) ui.toast(t.ports.forwarded(r.vmPort), 'success');
}

/**
 * A click on a URL in a Claude Code chat reaches both xterm (web-links) and Claude Code, which hands the link to the
 * app through BROWSER (agent event open_url). The same link within this time opens once.
 */
export const REPEAT_MS = 3000;
const opened = new Map<string, number>();

/** true when url was opened less than REPEAT_MS ago; otherwise remembers it and returns false */
export function openedRecently(url: string, now = Date.now(), seen = opened): boolean {
  for (const [u, at] of seen) if (now - at >= REPEAT_MS) seen.delete(u);
  if (seen.has(url)) return true;
  seen.set(url, now);
  return false;
}

/** a link clicked in the terminal: localhost/127.0.0.1/0.0.0.0 URLs go through a forward, others open as is */
export async function openLink(url: string): Promise<void> {
  if (openedRecently(url)) return;
  if (!parseLocalUrl(url)) {
    await invoke('launch.openExternal', { url });
    return;
  }
  report(await invoke('ports.open', { url }), true);
}

export async function openVmPort(vmPort: number): Promise<void> {
  report(await invoke('ports.open', { vmPort }), true);
}

export async function forwardVmPort(vmPort: number): Promise<void> {
  report(await invoke('ports.forward', { vmPort }), false);
}

/** links Claude Code (or anything else on the VM) opens with BROWSER=openurl.py: agent/cclib/openurl.py */
export function wireOpenUrl(): void {
  on('agent.event', ({ event, data }) => {
    if (event !== 'open_url') return;
    const url = (data as { url?: unknown } | null)?.url;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) void openLink(url);
  });
}
