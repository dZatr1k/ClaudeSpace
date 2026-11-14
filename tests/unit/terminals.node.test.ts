import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { HIGH_WATER, LOW_WATER, TerminalManager, terminalCommand } from '../../src/main/terminals';
import type { ExecChannel, ExecOptions, Transport } from '../../src/main/transport/types';

describe('terminalCommand', () => {
  it('tmux attach uses an exact target and -u', () => {
    const c = terminalCommand({ tabId: 't', kind: 'tmux', session: 'MyApp-2', cols: 80, rows: 24 });
    expect(c).toContain(`exec tmux -u attach-session -t '=MyApp-2'`);
    expect(terminalCommand({ tabId: 't', kind: 'tmux', session: 'a', cols: 80, rows: 24 }, 'sock')).toContain(
      `tmux -L 'sock' -u attach-session`,
    );
  });
  it('refuses bad session names', () => {
    expect(() =>
      terminalCommand({ tabId: 't', kind: 'tmux', session: "x'; rm -rf ~; '", cols: 80, rows: 24 }),
    ).toThrow();
    expect(() => terminalCommand({ tabId: 't', kind: 'tmux', cols: 80, rows: 24 })).toThrow();
  });
  it('quotes paths for shell/lazygit/yazi', () => {
    const c = terminalCommand({ tabId: 't', kind: 'shell', cwd: `/home/u/it's $(id)`, cols: 80, rows: 24 });
    expect(c).toContain(`cd '/home/u/it'\\''s $(id)' && exec bash -l`);
    expect(terminalCommand({ tabId: 't', kind: 'shell', cwd: '~', cols: 80, rows: 24 })).toContain(
      'cd "$HOME" &&',
    );
    expect(
      terminalCommand({ tabId: 't', kind: 'lazygit', cwd: '~/projects/a b', cols: 80, rows: 24 }),
    ).toContain(`cd "$HOME"/'projects/a b' && exec lazygit`);
    expect(terminalCommand({ tabId: 't', kind: 'yazi', cwd: '/x', cols: 80, rows: 24 })).toContain(
      `exec yazi '/x'`,
    );
  });
  it('git clone: url whitelist, quoted args, -- before url', () => {
    const c = terminalCommand({
      tabId: 't',
      kind: 'clone',
      url: 'https://github.com/a/b.git',
      dest: '/home/u/projects/b',
      cols: 80,
      rows: 24,
    });
    expect(c).toContain(`git clone -- 'https://github.com/a/b.git' '/home/u/projects/b'`);
    expect(() =>
      terminalCommand({
        tabId: 't',
        kind: 'clone',
        url: '--upload-pack=touch /tmp/x',
        dest: '/x',
        cols: 80,
        rows: 24,
      }),
    ).toThrow();
    expect(() =>
      terminalCommand({
        tabId: 't',
        kind: 'clone',
        url: 'https://x/$(id) y',
        dest: '/x',
        cols: 80,
        rows: 24,
      }),
    ).toThrow();
  });
});

class FakeCh extends EventEmitter implements ExecChannel {
  paused = false;
  written: (string | Buffer)[] = [];
  size: [number, number] | null = null;
  write(d: Buffer | string) {
    this.written.push(d);
    return true;
  }
  end() {}
  close() {
    this.emit('close', 0, null);
  }
  setWindow(r: number, c: number) {
    this.size = [r, c];
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
}

class FakeTransport extends EventEmitter implements Transport {
  readonly kind = 'local' as const;
  last: { cmd: string; opts?: ExecOptions; ch: FakeCh } | null = null;
  async exec(cmd: string, opts?: ExecOptions) {
    const ch = new FakeCh();
    this.last = { cmd, opts, ch };
    return ch;
  }
  async writeFile() {}
  close() {}
  debugDrop() {}
  debugFreeze() {}
}

describe('TerminalManager', () => {
  it('batches output, pauses above HIGH_WATER and resumes below LOW_WATER on acks', async () => {
    const t = new FakeTransport();
    const got: number[] = [];
    const exits: string[] = [];
    const tm = new TerminalManager(
      { data: (_id, d) => got.push(d.byteLength), exit: (id) => exits.push(id) },
      () => t,
    );
    await tm.open({ tabId: 'a', kind: 'shell', cwd: '~', cols: 100, rows: 30 });
    expect(t.last?.opts?.pty).toEqual({ cols: 100, rows: 30, term: 'xterm-256color' });
    const ch = t.last!.ch;
    for (let i = 0; i < 10; i++) ch.emit('data', Buffer.alloc(1000));
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toEqual([10000]); // one batch
    ch.emit('data', Buffer.alloc(HIGH_WATER));
    expect(ch.paused).toBe(true);
    tm.ack('a', HIGH_WATER + 10000 - LOW_WATER);
    expect(ch.paused).toBe(true);
    tm.ack('a', 1);
    expect(ch.paused).toBe(false);
    tm.resize('a', 120, 40);
    expect(ch.size).toEqual([40, 120]);
    tm.write('a', 'ls\r');
    expect(ch.written).toEqual(['ls\r']);
    ch.emit('close', 0, null);
    expect(exits).toEqual(['a']);
    expect(tm.has('a')).toBe(false);
  });

  it('close() kills the channel without reporting an exit; dropAll forgets silently', async () => {
    const t = new FakeTransport();
    const exits: string[] = [];
    const tm = new TerminalManager({ data: () => undefined, exit: (id) => exits.push(id) }, () => t);
    await tm.open({ tabId: 'a', kind: 'shell', cwd: '~', cols: 80, rows: 24 });
    tm.close('a');
    await tm.open({ tabId: 'b', kind: 'shell', cwd: '~', cols: 80, rows: 24 });
    const ch = t.last!.ch;
    tm.dropAll();
    ch.emit('close', null, null);
    expect(exits).toEqual([]);
  });

  it('fails without a transport', async () => {
    const tm = new TerminalManager({ data: () => undefined, exit: () => undefined }, () => null);
    await expect(tm.open({ tabId: 'a', kind: 'shell', cols: 80, rows: 24 })).rejects.toThrow(/нет связи/);
  });
});
