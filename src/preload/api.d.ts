import type { IpcChannel, IpcContract, IpcEventName, IpcEvents } from '../shared/ipc';

export interface CsBridge {
  invoke<C extends IpcChannel>(channel: C, args?: IpcContract[C]['args']): Promise<IpcContract[C]['result']>;
  on<E extends IpcEventName>(event: E, cb: (data: IpcEvents[E]) => void): () => void;
  platform: string;
}

declare global {
  interface Window {
    cs: CsBridge;
  }
}
