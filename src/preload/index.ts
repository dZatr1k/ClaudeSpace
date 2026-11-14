// The only bridge between the sandboxed renderer and main: whitelisted channels, no Node APIs exposed.
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC_CHANNEL_NAMES, IPC_EVENT_NAMES } from '../shared/channels';
import type { IpcChannel, IpcEventName } from '../shared/ipc';

const channels = new Set<string>(IPC_CHANNEL_NAMES);
const events = new Set<string>(IPC_EVENT_NAMES);

contextBridge.exposeInMainWorld('cs', {
  invoke(channel: IpcChannel, args?: unknown) {
    if (!channels.has(channel)) return Promise.reject(new Error(`unknown channel ${String(channel)}`));
    return ipcRenderer.invoke(channel, args);
  },
  on(event: IpcEventName, cb: (data: unknown) => void) {
    if (!events.has(event)) throw new Error(`unknown event ${String(event)}`);
    const h = (_e: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on(event, h);
    return () => ipcRenderer.removeListener(event, h);
  },
  platform: process.platform,
});
