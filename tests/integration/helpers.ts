// Shared test helpers: a fake HOME built by the agent's Python fixture, a dedicated tmux socket, waiting.
import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(__dirname, '../..');
export const BUNDLE = join(ROOT, 'resources', 'agent');
export const PTY_HELPER = join(ROOT, 'resources', 'ptyhelper.py');
export const TMUX_SOCKET = `claudespace-test-node-${process.pid}`;

export interface FakeHome {
  home: string;
  alpha: string;
  beta: string;
  cleanup(): void;
}

/** The bundle is built once in tests/globalSetup.ts; kept as a call site for readability. */
export function ensureBundle(): void {}

/** Fake HOME with transcripts, a session registry, secrets and a fake `claude` (agent/tests/fixtures.py). */
export function makeFakeHome(): FakeHome {
  const out = execFileSync(
    'python3',
    [
      '-c',
      'import sys; sys.path.insert(0, "agent"); from tests.fixtures import FakeHome; f = FakeHome(); print(f.home)',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  ).trim();
  return {
    home: out,
    alpha: join(out, 'projects', 'Alpha'),
    beta: join(out, 'projects', 'Beta'),
    cleanup: () => rmSync(out, { recursive: true, force: true }),
  };
}

export function tmux(...args: string[]): string {
  const r = spawnSync('tmux', ['-L', TMUX_SOCKET, ...args], { encoding: 'utf8' });
  return r.stdout;
}

export function killTmux(): void {
  spawnSync('tmux', ['-L', TMUX_SOCKET, 'kill-server']);
  try {
    unlinkSync(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.() ?? 0}`, TMUX_SOCKET));
  } catch {
    /* gone */
  }
}

export async function waitFor<T>(
  fn: () => T | undefined | null | false,
  timeoutMs = 10000,
  what = 'condition',
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
