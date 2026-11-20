// The bridge in the APK: a Capacitor plugin (mobile/android, BridgePlugin.kt) in front of the app's service, which
// runs the Kotlin core (mobile/core, PhoneCore.kt). Arguments, results and events cross as JSON text; terminal output
// and uploads as base64, like the dev bridge.
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type { MobileBridge, MobileEventName } from '@shared/mobile';
import { fromBase64, toBase64 } from '@shared/mobileWire';

interface CorePlugin {
  invoke(o: { channel: string; json: string }): Promise<{ json: string }>;
  addListener(name: 'event', cb: (e: { event: string; json: string }) => void): Promise<PluginListenerHandle>;
}

type Listener = (data: unknown) => void;

export function nativeBridge(): MobileBridge | null {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('ClaudeSpace')) return null;
  const plugin = registerPlugin<CorePlugin>('ClaudeSpace');
  const listeners = new Map<string, Set<Listener>>();
  void plugin.addListener('event', (e) => {
    let data: unknown = JSON.parse(e.json);
    if (e.event === 'term.data') {
      const d = data as { tabId: string; data64: string };
      data = { tabId: d.tabId, data: fromBase64(d.data64) };
    }
    for (const cb of listeners.get(e.event) ?? []) cb(data);
  });
  return {
    kind: 'android',
    async invoke(channel, args) {
      let wire: unknown = args ?? {};
      if (channel === 'attach.upload') {
        const a = args as { name: string; data: Uint8Array };
        wire = { name: a.name, data64: toBase64(a.data) };
      }
      const r = await plugin.invoke({ channel, json: JSON.stringify(wire) });
      return (r.json === undefined || r.json === '' ? undefined : JSON.parse(r.json)) as never;
    },
    on(event: MobileEventName, cb) {
      const set = listeners.get(event) ?? new Set<Listener>();
      listeners.set(event, set);
      set.add(cb as Listener);
      return () => set.delete(cb as Listener);
    },
  };
}
