// BACKLOG 11: main side of sudo prompts — enable on connect / setting change, attention on a request, the reply goes
// to the agent and the password never reaches the log.
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AskpassBroker } from '../../src/main/askpass';
import { defaultSettings } from '../../src/shared/settings';
import type { Settings } from '../../src/shared/settings';

class FakeConn extends EventEmitter {
  online = true;
  calls: [string, unknown][] = [];
  fail: Error | null = null;
  async call<T>(method: string, params: unknown): Promise<T> {
    this.calls.push([method, params]);
    if (this.fail) throw this.fail;
    return (method === 'askpass_enable' ? { listening: true, socket: '/s' } : {}) as T;
  }
}

const ID = '0123456789abcdef';

function setup() {
  const conn = new FakeConn();
  let settings: Settings = defaultSettings('win32');
  const logs: string[] = [];
  const seen: string[] = [];
  const b = new AskpassBroker({
    conn,
    settings: () => settings,
    log: (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
    attention: (r) => seen.push(r.id),
  }).attach();
  return { conn, b, logs, seen, set: (s: Settings) => (settings = s) };
}

describe('AskpassBroker', () => {
  it('enables the agent on connect and follows the setting', async () => {
    const { conn, b, set } = setup();
    conn.emit('online', {});
    await new Promise((r) => setTimeout(r, 0));
    expect(conn.calls).toEqual([['askpass_enable', { enabled: true }]]);
    const s = defaultSettings('win32');
    set({ ...s, askpass: { enabled: false } });
    await b.applySettings();
    expect(conn.calls[1]).toEqual(['askpass_enable', { enabled: false }]);
    conn.online = false;
    await b.applySettings();
    expect(conn.calls).toHaveLength(2);
  });

  it('tracks requests, calls attention, forgets on done / reconnect', () => {
    const { conn, b, seen } = setup();
    const req = { id: ID, prompt: 'p', command: 'sudo ls', cwd: null, session: null, at: 1 };
    conn.emit('agent-event', 'askpass_request', req);
    expect(seen).toEqual([ID]);
    expect([...b.pending.keys()]).toEqual([ID]);
    conn.emit('agent-event', 'askpass_done', { id: ID, reason: 'timeout' });
    expect(b.pending.size).toBe(0);
    conn.emit('agent-event', 'askpass_request', req);
    conn.emit('online', {});
    expect(b.pending.size).toBe(0);
  });

  it('reply goes to the agent; the password is never logged, also on failure', async () => {
    const { conn, b, logs } = setup();
    expect(await b.reply(ID, 'hunter2')).toEqual({ ok: true });
    expect(conn.calls.at(-1)).toEqual(['askpass_reply', { id: ID, password: 'hunter2' }]);
    expect(await b.reply(ID, null)).toEqual({ ok: true });
    conn.fail = new Error('запрос пароля уже закрыт');
    expect(await b.reply(ID, 'hunter2')).toEqual({ ok: false, error: 'запрос пароля уже закрыт' });
    expect(logs.join('\n')).not.toContain('hunter2');
    expect(logs.some((l) => l.includes('cancel'))).toBe(true);
  });
});
