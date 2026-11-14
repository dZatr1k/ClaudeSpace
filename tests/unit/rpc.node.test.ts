import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AgentRpc, RpcError } from '../../src/main/agent/rpc';
import type { ExecChannel } from '../../src/main/transport/types';

class FakeChannel extends EventEmitter implements ExecChannel {
  written: string[] = [];
  write(d: Buffer | string) {
    this.written.push(String(d));
    return true;
  }
  end() {}
  close() {
    this.emit('close', 0, null);
  }
  setWindow() {}
  pause() {}
  resume() {}
  push(s: string | Buffer) {
    this.emit('data', Buffer.isBuffer(s) ? s : Buffer.from(s));
  }
  lastId(): number {
    return JSON.parse(this.written[this.written.length - 1] as string).id;
  }
}

describe('AgentRpc', () => {
  it('matches responses by id (out of order)', async () => {
    const ch = new FakeChannel();
    const rpc = new AgentRpc(ch);
    const a = rpc.call('ping');
    const idA = ch.lastId();
    const b = rpc.call('list_dirs');
    const idB = ch.lastId();
    ch.push(`{"id":${idB},"result":{"dirs":["/x"]}}\n{"id":${idA},"result":{"now":1}}\n`);
    await expect(a).resolves.toEqual({ now: 1 });
    await expect(b).resolves.toEqual({ dirs: ['/x'] });
    expect(JSON.parse(ch.written[0] as string)).toEqual({ id: idA, method: 'ping', params: {} });
  });

  it('errors carry code/message/data', async () => {
    const ch = new FakeChannel();
    const rpc = new AgentRpc(ch);
    const p = rpc.call('archive_chat', { chatId: 'x' });
    ch.push(
      `{"id":${ch.lastId()},"error":{"code":"chat_open","message":"чат открыт","data":{"session":"S"}}}\n`,
    );
    const e = (await p.catch((x) => x)) as RpcError;
    expect(e).toBeInstanceOf(RpcError);
    expect(e.code).toBe('chat_open');
    expect(e.message).toBe('чат открыт');
    expect(e.toPayload()).toEqual({ code: 'chat_open', message: 'чат открыт', data: { session: 'S' } });
  });

  it('times out', async () => {
    vi.useFakeTimers();
    const rpc = new AgentRpc(new FakeChannel());
    const p = rpc.call('usage', {}, 1000);
    vi.advanceTimersByTime(1001);
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
    vi.useRealTimers();
  });

  it('emits events, handles lines split across chunks and UTF-8 split inside a char', async () => {
    const ch = new FakeChannel();
    const rpc = new AgentRpc(ch);
    const events: [string, unknown][] = [];
    rpc.on('event', (n, d) => events.push([n, d]));
    const line = Buffer.from('{"event":"system","data":{"host":"вм"}}\n');
    const cut = line.indexOf(Buffer.from('м')) + 1; // inside the 2-byte 'м'
    ch.push(line.subarray(0, cut));
    expect(events).toHaveLength(0);
    ch.push(line.subarray(cut));
    expect(events).toEqual([['system', { host: 'вм' }]]);
  });

  it('ignores garbage, logs errors without id, rejects pending on close', async () => {
    const ch = new FakeChannel();
    const rpc = new AgentRpc(ch);
    const logs: string[] = [];
    rpc.on('log', (s) => logs.push(s));
    ch.push('not json\n{"id":null,"error":{"code":"too_large","message":"big"}}\n');
    expect(logs.some((l) => l.includes('bad JSON'))).toBe(true);
    expect(logs.some((l) => l.includes('too_large'))).toBe(true);
    const p = rpc.call('ping');
    ch.close();
    await expect(p).rejects.toMatchObject({ code: 'closed' });
    await expect(rpc.call('ping')).rejects.toMatchObject({ code: 'closed' });
  });
});
