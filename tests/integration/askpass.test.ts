// BACKLOG 11 end to end in local mode: the installed askpass.py (as sudo would run it) -> agent socket -> Connection
// -> AskpassBroker (main) -> reply -> password on the script's stdout. The password must not appear in any log line.
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSettings } from '../../src/shared/settings';
import { Connection } from '../../src/main/connection';
import { AskpassBroker } from '../../src/main/askpass';
import { LocalTransport } from '../../src/main/transport/local';
import { BUNDLE, PTY_HELPER, TMUX_SOCKET, ensureBundle, killTmux, makeFakeHome, waitFor } from './helpers';
import type { FakeHome } from './helpers';

const PASSWORD = 'correct horse — батарея 42';
let fh: FakeHome;
beforeAll(() => {
  ensureBundle();
  killTmux();
  fh = makeFakeHome();
});
afterAll(() => {
  killTmux();
  fh.cleanup();
});

function runScript(home: string): Promise<{ code: number | null; out: string }> {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8' };
  const p = spawn(join(home, '.local/lib/claudespace/askpass.py'), ['[sudo] password for u:'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
  return new Promise((resolve) => p.on('close', (code) => resolve({ code, out })));
}

describe('askpass through the app', () => {
  it('prompt -> broker -> reply -> sudo gets the password; cancel; disabled -> fallback', async () => {
    const s = parseSettings({}, 'linux');
    s.connection.tmuxSocket = TMUX_SOCKET;
    const logs: string[] = [];
    const log = (...a: unknown[]) =>
      logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const conn = new Connection({
      settings: () => s,
      bundleDir: BUNDLE,
      ptyHelper: PTY_HELPER,
      appKnownHosts: join(fh.home, 'kh'),
      localFactory: () => new LocalTransport(PTY_HELPER, '/bin/bash', fh.home),
      log,
    });
    const attention: string[] = [];
    const broker = new AskpassBroker({
      conn,
      settings: () => s,
      log,
      attention: (r) => attention.push(r.id),
    });
    broker.attach();
    conn.start();
    try {
      await waitFor(() => conn.state.kind === 'online', 20000, 'online');
      // installed executable for sudo, owner only
      expect(statSync(join(fh.home, '.local/lib/claudespace/askpass.py')).mode & 0o777).toBe(0o700);
      await waitFor(() => logs.some((l) => l.includes('[askpass] enabled listening')), 10000, 'enabled');

      const run = runScript(fh.home);
      const id = await waitFor(() => broker.pending.keys().next().value, 10000, 'request');
      expect(attention).toEqual([id]);
      expect(broker.pending.get(id)?.prompt).toBe('[sudo] password for u:');
      expect(await broker.reply(id, PASSWORD)).toEqual({ ok: true });
      expect(await run).toEqual({ code: 0, out: PASSWORD + '\n' });

      const run2 = runScript(fh.home);
      const id2 = await waitFor(() => broker.pending.keys().next().value, 10000, 'request 2');
      await broker.reply(id2, null);
      expect(await run2).toEqual({ code: 1, out: '' });

      // setting off: the socket stops answering, the script falls back (no DISPLAY here -> exit 1 at once)
      s.askpass.enabled = false;
      await broker.applySettings();
      expect(await runScript(fh.home)).toEqual({ code: 1, out: '' });
      expect(broker.pending.size).toBe(0);
    } finally {
      conn.disconnect();
    }
    expect(logs.join('\n')).not.toContain(PASSWORD);
  });
});
