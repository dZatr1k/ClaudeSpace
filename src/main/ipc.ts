// IPC handlers: only the whitelisted channels (shared/ipc.ts), every argument validated with zod.
import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { ipcSchemas } from '../shared/ipc';
import type { IpcChannel, IpcContract } from '../shared/ipc';

type Handler<C extends IpcChannel> = (
  args: IpcContract[C]['args'],
  e: IpcMainInvokeEvent,
) => Promise<IpcContract[C]['result']> | IpcContract[C]['result'];

export type Handlers = { [C in IpcChannel]: Handler<C> };

export function registerIpc(handlers: Handlers, isTrustedSender: (e: IpcMainInvokeEvent) => boolean): void {
  for (const channel of Object.keys(ipcSchemas) as IpcChannel[]) {
    const schema = ipcSchemas[channel];
    const handler = handlers[channel] as Handler<IpcChannel>;
    ipcMain.handle(channel, async (e, raw: unknown) => {
      if (!isTrustedSender(e)) throw new Error('untrusted sender');
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new Error(`invalid arguments for ${channel}`);
      return handler(parsed.data as never, e);
    });
  }
}
