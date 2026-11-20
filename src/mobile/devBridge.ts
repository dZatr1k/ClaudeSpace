// The bridge in the browser (npm run mobile:dev): calls go over Vite's websocket to main's core, which runs inside the
// dev server (src/main/mobileDev.ts). Bytes travel as base64 (src/shared/mobileWire.ts).
import type { MobileBridge, MobileEventName } from '@shared/mobile';
import { WIRE, fromBase64, toBase64 } from '@shared/mobileWire';
import type { WireEvent, WireResult } from '@shared/mobileWire';
import type { ConnState } from '@shared/model';

type Listener = (data: never) => void;
type ViteHotContext = NonNullable<ImportMeta['hot']>;

export function devBridge(hot: ViteHotContext): MobileBridge & { simulate(state: ConnState | null): void } {
  let seq = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Set<Listener>>();

  hot.on(WIRE.result, (r: WireResult) => {
    const p = pending.get(r.id);
    if (!p) return;
    pending.delete(r.id);
    if (r.ok) p.resolve(r.result);
    else p.reject(new Error(r.error));
  });
  hot.on(WIRE.event, (e: WireEvent) => {
    let data = e.data;
    if (e.event === 'term.data') {
      const d = data as { tabId: string; data64: string };
      data = { tabId: d.tabId, data: fromBase64(d.data64) };
    }
    for (const cb of listeners.get(e.event) ?? []) (cb as (d: unknown) => void)(data);
  });

  return {
    kind: 'dev',
    invoke(channel, args) {
      if (channel === 'launch.openExternal') {
        window.open((args as { url: string }).url, '_blank', 'noopener');
        return Promise.resolve(undefined as never);
      }
      let wire: unknown = args;
      if (channel === 'attach.upload') {
        const a = args as { name: string; data: Uint8Array };
        wire = { name: a.name, data64: toBase64(a.data) };
      }
      const id = seq++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        hot.send(WIRE.invoke, { id, channel, args: wire });
      });
    },
    on(event: MobileEventName, cb) {
      const set = listeners.get(event) ?? new Set<Listener>();
      listeners.set(event, set);
      set.add(cb as Listener);
      return () => set.delete(cb as Listener);
    },
    simulate(state) {
      hot.send(WIRE.simulate, { state });
    },
  };
}
