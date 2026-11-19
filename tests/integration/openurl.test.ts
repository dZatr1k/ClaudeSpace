// Links from chats in local mode: the installed openurl.py (as Claude Code runs $BROWSER) -> agent socket ->
// Connection 'agent-event' open_url. The renderer side (dedupe, port forward) is in tests/unit/openLink.web.test.ts.
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSettings } from '../../src/shared/settings';
import { Connection } from '../../src/main/connection';
import { LocalTransport } from '../../src/main/transport/local';
import { BUNDLE, PTY_HELPER, TMUX_SOCKET, ensureBundle, killTmux, makeFakeHome, waitFor } from './helpers';
import type { FakeHome } from './helpers';

const URL1 = 'https://example.com/jobs/7539589e?ref=claudespace';
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

function runScript(home: string, url: string): Promise<number | null> {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8' };
  const p = spawn(join(home, '.local/lib/claudespace/openurl.py'), [url], { env, stdio: 'ignore' });
  return new Promise((resolve) => p.on('close', (code) => resolve(code)));
}

/** run the script until it exits with `want` (the agent binds its socket a moment after it is online) */
async function scriptUntil(want: number, timeoutMs = 10000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const code = await runScript(fh.home, URL1);
    if (code === want) return;
    if (Date.now() > end) throw new Error(`openurl.py exited ${code}, want ${want}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('links from the VM through the app', () => {
  it('BROWSER script -> agent -> open_url event; no app -> exit 1', async () => {
    const s = parseSettings({}, 'linux');
    s.connection.tmuxSocket = TMUX_SOCKET;
    const conn = new Connection({
      settings: () => s,
      bundleDir: BUNDLE,
      ptyHelper: PTY_HELPER,
      appKnownHosts: join(fh.home, 'kh'),
      localFactory: () => new LocalTransport(PTY_HELPER, '/bin/bash', fh.home),
      log: () => undefined,
    });
    const urls: unknown[] = [];
    conn.on('agent-event', (name: string, data: unknown) => {
      if (name === 'open_url') urls.push((data as { url: unknown }).url);
    });
    conn.start();
    try {
      await waitFor(() => conn.state.kind === 'online', 20000, 'online');
      expect(statSync(join(fh.home, '.local/lib/claudespace/openurl.py')).mode & 0o777).toBe(0o700);
      // the agent starts listening right after it connected
      await scriptUntil(0);
      await waitFor(() => urls.length > 0, 10000, 'event');
      expect(urls).toEqual([URL1]);
    } finally {
      conn.disconnect();
    }
    // the agent is gone: no socket, no desktop here -> the script fails, Claude Code says so
    await scriptUntil(1);
  });
});
