// Typed access to window.cs (preload) and the agent RPC.
import type { IpcChannel, IpcContract, IpcEventName, IpcEvents } from '@shared/ipc';
import type { AgentErrorPayload, Method, MethodParams, MethodResults } from '@shared/protocol';

export function invoke<C extends IpcChannel>(
  channel: C,
  args?: IpcContract[C]['args'],
): Promise<IpcContract[C]['result']> {
  return window.cs.invoke(channel, args);
}

export function on<E extends IpcEventName>(event: E, cb: (d: IpcEvents[E]) => void): () => void {
  return window.cs.on(event, cb);
}

export class AgentCallError extends Error {
  constructor(readonly payload: AgentErrorPayload) {
    super(payload.message);
  }
  get code(): string {
    return this.payload.code;
  }
}

export async function agent<M extends Method>(
  method: M,
  params?: MethodParams[M],
): Promise<MethodResults[M]> {
  const r = await invoke('agent.call', { method, params: (params ?? {}) as MethodParams[Method] });
  if (!r.ok) throw new AgentCallError(r.error);
  return r.result as MethodResults[M];
}
