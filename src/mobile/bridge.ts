// Typed access to the phone's core (src/shared/mobile.ts): the Android service, or main's core under Vite in dev.
import type {
  MobileBridge,
  MobileChannel,
  MobileContract,
  MobileEventName,
  MobileEvents,
} from '@shared/mobile';
import type { AgentErrorPayload, Method, MethodParams, MethodResults } from '@shared/protocol';

let bridge: MobileBridge | null = null;

export function setBridge(b: MobileBridge | null): void {
  bridge = b;
}

export function hasBridge(): boolean {
  return bridge !== null;
}

function need(): MobileBridge {
  if (!bridge) throw new Error('no bridge');
  return bridge;
}

export function invoke<C extends MobileChannel>(
  channel: C,
  args?: MobileContract[C]['args'],
): Promise<MobileContract[C]['result']> {
  return need().invoke(channel, args);
}

export function on<E extends MobileEventName>(event: E, cb: (d: MobileEvents[E]) => void): () => void {
  return need().on(event, cb);
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
