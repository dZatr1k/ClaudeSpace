// Local transport (dev mode on the VM): installer, agent RPC, tmux terminal through the Python PTY helper.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSettings } from '../../src/shared/settings';
import { Connection } from '../../src/main/connection';
import { ensureAgent, probe } from '../../src/main/agent/installer';
import { LocalTransport } from '../../src/main/transport/local';
import { TerminalManager } from '../../src/main/terminals';
import {
  BUNDLE,
  PTY_HELPER,
  TMUX_SOCKET,
  ensureBundle,
  killTmux,
  makeFakeHome,
  tmux,
  waitFor,
} from './helpers';
import type { FakeHome } from './helpers';

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

describe('local transport', () => {
  it('installer: probe, install, no-op on same hash', async () => {
    const t = new LocalTransport(PTY_HELPER, '/bin/bash', fh.home);
    const p = await probe(t);
    expect(p.python).toBeTruthy();
    expect(p.pythonOk).toBe(true);
    expect(p.tmux).toBeTruthy();
    expect(p.installed).toBeNull();
    expect((await ensureAgent(t, BUNDLE)).installed).toBe(true);
    expect((await ensureAgent(t, BUNDLE)).installed).toBe(false);
    const m = JSON.parse(readFileSync(join(fh.home, '.local/lib/claudespace/MANIFEST.json'), 'utf8'));
    expect(m.hash).toBe(JSON.parse(readFileSync(join(BUNDLE, 'MANIFEST.json'), 'utf8')).hash);
    t.close();
  });

  it('connection in local mode + tmux tab with Cyrillic and box drawing', async () => {
    const s = parseSettings({}, 'linux');
    s.connection.tmuxSocket = TMUX_SOCKET;
    const conn = new Connection({
      settings: () => s,
      bundleDir: BUNDLE,
      ptyHelper: PTY_HELPER,
      appKnownHosts: join(fh.home, 'kh'),
      localFactory: () => new LocalTransport(PTY_HELPER, '/bin/bash', fh.home),
    });
    conn.start();
    await waitFor(() => conn.state.kind === 'online', 20000, 'online');
    expect(conn.hello?.home).toBe(fh.home);
    const r = await conn.call<{ session: string }>('new_session', { cwd: fh.beta }, 10000);
    const out: Buffer[] = [];
    const tm = new TerminalManager(
      { data: (_i, d) => out.push(Buffer.from(d)), exit: () => undefined },
      () => conn.transport,
      () => TMUX_SOCKET,
    );
    await tm.open({ tabId: 'x', kind: 'tmux', session: r.session, cols: 90, rows: 25 });
    await waitFor(() => Buffer.concat(out).toString().includes('fake claude'), 10000, 'claude');
    // UTF-8 goes through tmux -u and the PTY intact
    tm.write('x', 'привет ─│┌ ✻');
    await waitFor(
      () => {
        const o = Buffer.concat(out).toString();
        return o.includes('привет') && o.includes('─│┌') && o.includes('✻');
      },
      5000,
      'utf8',
    ).catch((e) => {
      console.error(
        JSON.stringify(Buffer.concat(out).toString().slice(-600)),
        tmux('capture-pane', '-p', '-t', `=${r.session}:`),
      );
      throw e;
    });
    tm.resize('x', 100, 30);
    await waitFor(
      () => tmux('list-clients', '-F', '#{client_width}x#{client_height}').includes('100x30'),
      5000,
      'resize',
    );
    tm.close('x');
    await conn.call('kill_session', { session: r.session }, 10000);
    conn.disconnect();
  }, 60000);
});
