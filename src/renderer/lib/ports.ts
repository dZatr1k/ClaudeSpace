// Opening VM ports in the PC's browser (BACKLOG 10): forward first, then open; say so if the PC port differs.
import { parseLocalUrl } from '@shared/ports';
import type { PortOpenResult } from '@shared/ipc';
import { invoke } from '../bridge';
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

/** a link clicked in the terminal: localhost/127.0.0.1/0.0.0.0 URLs go through a forward, others open as is */
export async function openLink(url: string): Promise<void> {
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
