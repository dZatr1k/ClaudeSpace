/// <reference lib="dom" />
// Electron e2e (Playwright _electron) in local mode against a fake HOME and a dedicated tmux socket.
// Needs an X display: DISPLAY (xvfb-run or an existing session). Screenshots go to docs/screenshots/.
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, TMUX_SOCKET, ensureBundle, killTmux, makeFakeHome, tmux } from '../integration/helpers';
import type { FakeHome } from '../integration/helpers';
import type {} from '../../src/preload/api';

const SHOTS = join(ROOT, 'docs', 'screenshots');
let fh: FakeHome;
let ud: string;

async function launch(): Promise<{ app: ElectronApplication; win: Page; errors: string[] }> {
  const app = await electron.launch({
    executablePath: join(ROOT, 'node_modules', 'electron', 'dist', 'electron'),
    args: ['--no-sandbox', ROOT],
    // CSAGENT_HOSTNAME + the fake ~/.tmux.conf: the real host name must not end up in docs/screenshots
    env: {
      ...process.env,
      HOME: fh.home,
      CLAUDESPACE_USER_DATA: ud,
      TMUX: '',
      CSAGENT_HOSTNAME: 'vm',
    } as Record<string, string>,
  });
  const win = await app.firstWindow();
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
  return { app, win, errors };
}

async function setTheme(win: Page, theme: 'dark' | 'light') {
  await win.evaluate((t) => window.cs.invoke('settings.set', { appearance: { theme: t } }), theme);
  await win.waitForTimeout(300);
}

test.beforeAll(() => {
  test.skip(!process.env.DISPLAY, 'needs an X display');
  ensureBundle();
  killTmux();
  fh = makeFakeHome();
  writeFileSync(join(fh.home, '.tmux.conf'), `set -g status-right '"vm" %H:%M %d-%b-%y'\n`);
  ud = mkdtempSync(join(tmpdir(), 'cs-e2e-ud-'));
  writeFileSync(
    join(ud, 'settings.json'),
    JSON.stringify({ connection: { mode: 'local', tmuxSocket: TMUX_SOCKET }, appearance: { theme: 'dark' } }),
  );
  mkdirSync(SHOTS, { recursive: true });
});

test.afterAll(() => {
  killTmux();
  fh?.cleanup();
  if (ud) rmSync(ud, { recursive: true, force: true });
});

test('main window, sidebar, terminal, overlays, reconnect, restore', async () => {
  const first = await launch();
  let { app, win } = first;
  // online: projects from the fake HOME, status bar with the agent data
  await expect(win.getByTestId('project-Alpha')).toBeVisible({ timeout: 30_000 });
  await expect(win.locator('[data-conn="online"]').first()).toBeVisible();
  await expect(win.getByTestId('start-screen')).toBeVisible();
  const fontsOk = await win.evaluate(async () => {
    await document.fonts.load('13px Inter', 'Привет');
    await document.fonts.load('14px "JetBrains Mono"', 'Привет');
    return (
      document.fonts.check('13px Inter', 'Привет') && document.fonts.check('14px "JetBrains Mono"', 'Привет')
    );
  });
  expect(fontsOk).toBe(true);
  await win.screenshot({ path: join(SHOTS, '01-main-dark.png') });
  await setTheme(win, 'light');
  expect(await win.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
  await win.screenshot({ path: join(SHOTS, '02-main-light.png') });
  await setTheme(win, 'dark');

  // chats tab + right panel for a chat
  await win.getByRole('tab', { name: 'Чаты' }).click();
  await win.getByTestId('chat-11111111-1111-4111-8111-111111111111').click();
  await expect(win.locator('[data-right-panel]')).toContainText('Готово, собрал.');
  await win.screenshot({ path: join(SHOTS, '03-chats-info.png') });

  // project -> Enter = new chat in a tmux tab; the fake claude prints into the terminal
  await win.getByRole('tab', { name: 'Проекты' }).click();
  await win.getByTestId('project-Alpha').dblclick();
  const term = win.locator('[data-terminal][data-term-state="live"]');
  await expect(term).toBeVisible({ timeout: 15_000 });
  await expect(win.locator('.xterm-rows').first()).toContainText('fake claude', { timeout: 10_000 });
  await expect(win.getByTestId('session-Alpha')).toBeVisible({ timeout: 10_000 });
  // type Cyrillic + box drawing through the terminal
  await win.locator('.xterm-helper-textarea').first().focus();
  await win.keyboard.type('echo привет ─│┌ ✻');
  await expect(win.locator('.xterm-rows').first()).toContainText('привет ─│┌ ✻', { timeout: 5000 });
  await win.screenshot({ path: join(SHOTS, '04-terminal.png') });
  // narrow window (minimum size): the right panel hides itself, the tab strip and the status bar must still fit
  await win.setViewportSize({ width: 960, height: 600 });
  await win.waitForTimeout(300);
  await win.screenshot({ path: join(SHOTS, '12-narrow.png') });
  await win.setViewportSize({ width: 1440, height: 900 });

  // right panel for the session: Claude registered for its pane -> chat title, status, last prompt (no screen copy)
  const [paneId, panePid] = tmux('list-panes', '-t', '=Alpha', '-F', '#{pane_id} #{pane_pid}')
    .trim()
    .split(' ');
  const procStart = readFileSync(`/proc/${panePid}/stat`, 'utf8').split(')').pop()?.trim().split(' ')[19];
  writeFileSync(
    join(fh.home, '.claude', 'sessions', `${panePid}.json`),
    JSON.stringify({
      pid: Number(panePid),
      sessionId: '11111111-1111-4111-8111-111111111111',
      cwd: fh.alpha,
      procStart,
      status: 'busy',
      statusUpdatedAt: Date.now() - 125_000,
      tmux: `Alpha:@1.${paneId}`,
    }),
  );
  await win.getByTestId('session-Alpha').click();
  const info = win.locator('[data-session-info]');
  await expect(info).toContainText('Починка сборки', { timeout: 10_000 });
  await expect(info).toContainText('думает 2 мин');
  await expect(info.locator('[data-last-prompt]')).toHaveText('почини сборку');
  await expect(info).toContainText('только это окно');
  await win.screenshot({ path: join(SHOTS, '09-session-info.png') });
  await setTheme(win, 'light');
  await win.screenshot({ path: join(SHOTS, '13-session-light.png') });
  await setTheme(win, 'dark');
  // chat title -> the chat in the «Чаты» list, selected
  await info.getByTitle('Показать в списке чатов').click();
  await expect(win.getByRole('tab', { name: 'Чаты' })).toHaveAttribute('aria-selected', 'true');
  await expect(win.getByTestId('chat-11111111-1111-4111-8111-111111111111')).toBeVisible();

  // palette
  await win.keyboard.press('Control+Shift+P');
  await expect(win.getByPlaceholder(/Чаты, проекты/)).toBeVisible();
  await win.keyboard.type('alp');
  await win.waitForTimeout(200);
  await win.screenshot({ path: join(SHOTS, '05-palette.png') });
  await win.keyboard.press('Escape');

  // system overlay (doctor) and settings
  await win.evaluate(() => document.querySelector<HTMLElement>('[data-testid="status-conn"]')?.blur());
  await win.getByRole('button', { name: /Claude claude-1.0.0/ }).click();
  await expect(win.getByText('Реестр запущенных Claude')).toBeVisible({ timeout: 30_000 });
  await win.screenshot({ path: join(SHOTS, '06-system-doctor.png') });
  await win.keyboard.press('Escape');
  await win.getByRole('button', { name: /Настройки/ }).click();
  await win.getByRole('button', { name: 'Внешний вид' }).click();
  await win.screenshot({ path: join(SHOTS, '07-settings.png') });
  await win.keyboard.press('Escape');

  // sudo prompt from the VM (BACKLOG 11): the installed askpass.py, run like sudo does -> modal -> its stdout
  const sudoPw = 'e2e-пароль 42';
  const sudo = spawn(
    'sh',
    ['-c', '"$0" "$1"', join(fh.home, '.local/lib/claudespace/askpass.py'), '[sudo] password for u:'],
    { env: { PATH: process.env.PATH, HOME: fh.home, LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let sudoOut = '';
  sudo.stdout.on('data', (b: Buffer) => (sudoOut += b.toString('utf8')));
  const sudoDone = new Promise<number | null>((r) => sudo.on('close', r));
  await expect(win.getByTestId('askpass-input')).toBeVisible({ timeout: 15_000 });
  await expect(win.getByTestId('askpass-command')).toContainText('sh -c');
  await win.getByTestId('askpass-input').fill(sudoPw);
  await win.screenshot({ path: join(SHOTS, '10-askpass.png') });
  await win.keyboard.press('Enter');
  expect(await sudoDone).toBe(0);
  expect(sudoOut).toBe(sudoPw + '\n');
  await expect(win.getByTestId('askpass-input')).toBeHidden();
  expect(readFileSync(join(ud, 'logs', 'main.log'), 'utf8')).not.toContain(sudoPw);

  // full-text search through transcripts (stage 6): Ctrl+Shift+H, streamed hits, click shows the chat in the list
  await win.keyboard.press('Control+Shift+H');
  await win.getByTestId('chat-search-input').fill('почини');
  const hit = win.getByTestId('search-hit-11111111-1111-4111-8111-111111111111');
  await expect(hit).toBeVisible({ timeout: 15_000 });
  await expect(hit.locator('mark')).toHaveText('почини');
  await expect(win.getByTestId('chat-search-status')).toContainText('найдено чатов: 1');
  await win.screenshot({ path: join(SHOTS, '11-chat-search.png') });
  await hit.click();
  await expect(win.getByTestId('chat-search-input')).toBeHidden();
  await expect(win.getByRole('tab', { name: 'Чаты' })).toHaveAttribute('aria-selected', 'true');

  // close to tray: the window only hides, the app (and the connection) stay; showing it again works
  await win.evaluate(() => window.cs.invoke('settings.set', { tray: { closeToTray: true } }));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
    .toBe(false);
  expect(await win.evaluate(() => window.cs.invoke('conn.state').then((s) => s.kind))).toBe('online');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
  await win.evaluate(() => window.cs.invoke('settings.set', { tray: { closeToTray: false } }));

  // Ctrl+B d inside the terminal: the tab is detached, not closed
  await win.locator('.xterm-helper-textarea').first().focus();
  await win.keyboard.press('Control+b');
  await win.keyboard.press('d');
  await expect(win.locator('[data-term-state="detached"]')).toBeVisible({ timeout: 10_000 });
  await win.getByRole('button', { name: 'Подключить снова' }).click();
  await expect(win.locator('[data-term-state="live"]')).toBeVisible({ timeout: 10_000 });

  // debug drop: offline overlay, then automatic reconnect + reattach
  await win.evaluate(() => window.cs.invoke('conn.debugDrop'));
  await expect(win.getByText('Нет связи с VM').first()).toBeVisible({ timeout: 10_000 });
  await win.waitForTimeout(250); // let the state card finish its entry motion (DESIGN §5.6)
  await win.screenshot({ path: join(SHOTS, '08-offline.png') });
  await expect(win.locator('[data-term-state="live"]')).toBeVisible({ timeout: 30_000 });

  // session killed from outside -> "Сессия завершена"
  const name = (await win.locator('[role="tab"][data-tab]').first().getAttribute('data-tab')) as string;
  await win.waitForTimeout(800);
  await app.close();

  // restart: the tmux tab is restored and reattached
  const second = await launch();
  ({ app, win } = second);
  const errors = second.errors;
  await expect(win.locator(`[role="tab"][data-tab="${name}"]`)).toBeVisible({ timeout: 30_000 });
  await expect(win.locator('[data-term-state="live"]')).toBeVisible({ timeout: 30_000 });
  tmux('kill-session', '-t', `=${name}`);
  await expect(win.getByText(`Сессия «${name}» завершена`)).toBeVisible({ timeout: 15_000 });
  await win.waitForTimeout(250); // entry motion of the state card
  await win.screenshot({ path: join(SHOTS, '09-session-ended.png') });
  expect(first.errors.filter((e) => !/Autofill|DevTools/.test(e))).toEqual([]);
  expect(errors.filter((e) => !/Autofill|DevTools/.test(e))).toEqual([]);
  await app.close();
});
