import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ClientChannel } from 'ssh2';
import { SshChannel } from '../../src/main/transport/ssh';

function fakeChannel() {
  const ch = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  ch.stderr = new EventEmitter();
  return ch;
}

describe('SshChannel', () => {
  it('keeps output and close that arrive before anyone subscribes (Windows probe bug)', async () => {
    const raw = fakeChannel();
    const ch = new SshChannel(raw as unknown as ClientChannel);
    // the server answers in the same tick the channel opens, before `await t.exec()` resolves
    raw.emit('data', Buffer.from('py=/usr/bin/python3\n'));
    raw.stderr.emit('data', Buffer.from('warn\n'));
    raw.emit('data', Buffer.from('pyok=1\n'));
    raw.emit('exit', 0);
    raw.emit('close');

    await Promise.resolve(); // what `await t.exec()` costs the caller
    const got: string[] = [];
    let code: unknown = 'none';
    ch.on('data', (b: Buffer) => got.push(b.toString()));
    ch.on('close', (c: unknown) => (code = c));
    await new Promise((r) => setTimeout(r, 0));

    expect(got.join('')).toBe('py=/usr/bin/python3\npyok=1\n');
    expect(code).toBe(0);
  });

  it('does not block on an event nobody listens to', async () => {
    const raw = fakeChannel();
    const ch = new SshChannel(raw as unknown as ClientChannel);
    raw.stderr.emit('data', Buffer.from('ignored\n'));
    raw.emit('data', Buffer.from('a'));
    const got: string[] = [];
    ch.on('data', (b: Buffer) => got.push(b.toString()));
    await new Promise((r) => setTimeout(r, 0));
    raw.emit('data', Buffer.from('b'));
    expect(got.join('')).toBe('ab');
  });

  it('delivers live events directly once subscribed', () => {
    const raw = fakeChannel();
    const ch = new SshChannel(raw as unknown as ClientChannel);
    const got: string[] = [];
    ch.on('data', (b: Buffer) => got.push(b.toString()));
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        raw.emit('data', Buffer.from('x'));
        expect(got).toEqual(['x']);
        resolve();
      }, 0);
    });
  });
});
