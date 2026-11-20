// The APK's bridge (src/mobile/nativeBridge.ts) over a stand-in for the Capacitor plugin: JSON text both ways,
// uploads and terminal output as base64, events to the right listeners.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent: { channel: string; json: string }[] = [];
let emit: ((e: { event: string; json: string }) => void) | null = null;
let native = true;

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => native, isPluginAvailable: (n: string) => n === 'ClaudeSpace' },
  registerPlugin: () => ({
    invoke: async (o: { channel: string; json: string }) => {
      sent.push(o);
      return { json: o.channel === 'conn.retryNow' ? 'null' : JSON.stringify({ echo: o.channel }) };
    },
    addListener: async (_n: string, cb: (e: { event: string; json: string }) => void) => {
      emit = cb;
      return { remove: async () => undefined };
    },
  }),
}));

const { nativeBridge } = await import('../../src/mobile/nativeBridge');

describe('native bridge', () => {
  beforeEach(() => {
    sent.length = 0;
    native = true;
  });

  it('is absent outside the app', () => {
    native = false;
    expect(nativeBridge()).toBeNull();
  });

  it('sends arguments as JSON, uploads as base64, parses results', async () => {
    const b = nativeBridge()!;
    expect(b.kind).toBe('android');
    expect(await b.invoke('settings.get')).toEqual({ echo: 'settings.get' });
    expect(sent[0]).toEqual({ channel: 'settings.get', json: '{}' });
    expect(await b.invoke('conn.retryNow')).toBeNull();
    await b.invoke('attach.upload', { name: 'a.txt', data: new TextEncoder().encode('hi') });
    expect(JSON.parse(sent[2]!.json)).toEqual({ name: 'a.txt', data64: 'aGk=' });
  });

  it('delivers events, terminal output as bytes', () => {
    const b = nativeBridge()!;
    const got: unknown[] = [];
    const off = b.on('term.data', (d) => got.push(d));
    b.on('notify.click', (d) => got.push(d));
    emit!({ event: 'term.data', json: JSON.stringify({ tabId: 't', data64: 'aGk=' }) });
    emit!({ event: 'notify.click', json: JSON.stringify({ session: 'Alpha', chatId: null }) });
    expect(got).toEqual([
      { tabId: 't', data: new TextEncoder().encode('hi') },
      { session: 'Alpha', chatId: null },
    ]);
    off();
    emit!({ event: 'term.data', json: JSON.stringify({ tabId: 't', data64: '' }) });
    expect(got).toHaveLength(2);
  });
});
