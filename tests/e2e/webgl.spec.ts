/// <reference lib="dom" />
// BACKLOG 6 with a real WebGL renderer: SwiftShader (software GPU) gives Electron WebGL2 without a GPU. Run with
//   E2E_GL=1 DISPLAY=:10 npx playwright test tests/e2e/webgl.spec.ts
// Also checks that a background tab is not drawn (docs/PERF.md, item 1).
// Skipped otherwise (CI has no WebGL; the smoke test then runs on the DOM renderer).
import { _electron as electron, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, TMUX_SOCKET, ensureBundle, killTmux, makeFakeHome } from '../integration/helpers';
import type { FakeHome } from '../integration/helpers';

let fh: FakeHome;
let ud: string;

test.beforeAll(() => {
  test.skip(!process.env.DISPLAY || !process.env.E2E_GL, 'needs an X display and E2E_GL=1');
  ensureBundle();
  killTmux();
  fh = makeFakeHome();
  ud = mkdtempSync(join(tmpdir(), 'cs-e2e-gl-'));
  writeFileSync(
    join(ud, 'settings.json'),
    JSON.stringify({ connection: { mode: 'local', tmuxSocket: TMUX_SOCKET }, appearance: { theme: 'dark' } }),
  );
});

test.afterAll(() => {
  killTmux();
  fh?.cleanup();
  if (ud) rmSync(ud, { recursive: true, force: true });
});

test('WebGL glyphs are drawn at full size and the terminal keeps WebGL', async () => {
  const app = await electron.launch({
    executablePath: join(ROOT, 'node_modules', 'electron', 'dist', 'electron'),
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', ROOT],
    env: {
      ...process.env,
      HOME: fh.home,
      CLAUDESPACE_USER_DATA: ud,
      TMUX: '',
      CSAGENT_HOSTNAME: 'vm',
    } as Record<string, string>,
  });
  try {
    const win = await app.firstWindow();
    await win.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
    await expect(win.locator('[data-conn="online"]').first()).toBeVisible({ timeout: 20_000 });
    await win.getByTestId('project-Alpha').dblclick();
    await expect(win.locator('[data-terminal][data-term-state="live"]')).toBeVisible({ timeout: 15_000 });
    const log = (re: RegExp) => () => readFileSync(join(ud, 'logs', 'main.log'), 'utf8').match(re)?.[1] ?? '';
    await expect.poll(log(/\[webgl-probe\] (.*)/), { timeout: 20_000 }).toMatch(/"ok":true,"ratio":(0\.9|1)/);
    await expect.poll(log(/\[webgl-live\] (.*)/), { timeout: 30_000 }).toMatch(/"ok":true,"ratio":(0\.9|1)/);
    console.warn('webgl-live', log(/\[webgl-live\] (.*)/)());
    await expect(win.locator('.xterm-screen canvas').first()).toBeVisible();
    await win.screenshot({ path: join(ROOT, 'test-results', 'webgl.png') });

    // a background tab is not drawn (docs/PERF.md, item 1): count WebGL draw calls per terminal while both get output
    await win.getByTestId('project-Beta').dblclick();
    await expect(win.locator('[data-terminal][data-term-state="live"]')).toHaveCount(2, { timeout: 15_000 });
    await win.evaluate(() => {
      const draws: Record<string, number> = {};
      (window as unknown as { draws: Record<string, number> }).draws = draws;
      const proto = WebGL2RenderingContext.prototype as unknown as Record<
        string,
        (...a: unknown[]) => unknown
      >;
      for (const name of ['drawElementsInstanced', 'drawArraysInstanced', 'drawElements', 'drawArrays']) {
        const orig = proto[name]!;
        proto[name] = function (this: WebGL2RenderingContext, ...a: unknown[]) {
          const host = (this.canvas as HTMLCanvasElement).closest('[data-terminal]');
          const key = host ? (host.hasAttribute('data-pane') ? 'shown' : 'background') : 'other';
          draws[key] = (draws[key] ?? 0) + 1;
          return orig.apply(this, a);
        };
      }
    });
    const ttys = execFileSync('tmux', ['-L', TMUX_SOCKET, 'list-panes', '-a', '-F', '#{pane_tty}'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    expect(ttys).toHaveLength(2);
    for (let i = 0; i < 20; i++) {
      for (const tty of ttys) appendFileSync(tty, `line ${i}\r\n`);
      await win.waitForTimeout(100);
    }
    const draws = await win.evaluate(() => (window as unknown as { draws: Record<string, number> }).draws);
    console.warn('draws', JSON.stringify(draws));
    expect(draws.shown ?? 0).toBeGreaterThan(5);
    expect(draws.background ?? 0).toBe(0);
  } finally {
    await app.close();
  }
});
