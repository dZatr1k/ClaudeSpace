/// <reference lib="dom" />
// Electron e2e (Playwright _electron) in local mode against a fake HOME and a dedicated tmux socket.
// Needs an X display: DISPLAY (xvfb-run or an existing session). Screenshots go to docs/screenshots/.
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
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
  // shell tabs: a neutral prompt, the real user and host name must not end up in docs/screenshots
  writeFileSync(join(fh.home, '.bashrc'), "PS1='vm:\\w$ '\n");
  writeFileSync(join(fh.home, '.bash_profile'), '. ~/.bashrc\n'); // shell tabs run bash -l
  writeFileSync(join(fh.home, '.sudo_as_admin_successful'), '');
  ud = mkdtempSync(join(tmpdir(), 'cs-e2e-ud-'));
  writeFileSync(
    join(ud, 'settings.json'),
    JSON.stringify({ connection: { mode: 'local', tmuxSocket: TMUX_SOCKET }, appearance: { theme: 'dark' } }),
  );
  mkdirSync(SHOTS, { recursive: true });
  // a fake ccusage with a week of numbers for the «Расход» charts (the real one reads ~/.claude logs)
  const day = (n: number) => new Date(Date.now() - n * 86400_000).toLocaleDateString('sv-SE');
  const tok = [12, 30, 0, 48, 22, 61, 35].map((m) => m * 1e6);
  const daily = {
    daily: tok.map((v, i) => ({
      period: day(6 - i),
      totalTokens: v,
      totalCost: v / 2.5e6,
      modelBreakdowns: v
        ? [{ modelName: 'claude-opus-5-5', inputTokens: v * 0.9, outputTokens: v * 0.1, cost: v / 2.5e6 }]
        : [],
    })),
  };
  const now = Date.now();
  const blocks = {
    blocks: [
      {
        startTime: new Date(now - 90 * 60_000).toISOString(),
        endTime: new Date(now + 210 * 60_000).toISOString(),
        totalTokens: 35e6,
        costUSD: 14,
        isActive: true,
        burnRate: { tokensPerMinute: 390_000, costPerHour: 9.3 },
        projection: { totalTokens: 117e6, totalCost: 46 },
        models: ['claude-opus-5-5'],
      },
    ],
  };
  const sessions = {
    session: [
      { period: '11111111-1111-4111-8111-111111111111', totalTokens: 140e6, totalCost: 56 },
      { period: 'ffffffff-ffff-4fff-8fff-ffffffffffff', totalTokens: 68e6, totalCost: 27 },
    ],
  };
  mkdirSync(join(fh.home, 'fake-ccusage'), { recursive: true });
  for (const [k, v] of Object.entries({ daily, blocks, session: sessions }))
    writeFileSync(join(fh.home, 'fake-ccusage', `${k}.json`), JSON.stringify(v));
  writeFileSync(join(fh.home, '.local', 'bin', 'ccusage'), `#!/bin/sh\ncat "$HOME/fake-ccusage/$1.json"\n`, {
    mode: 0o755,
  });
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
  // BACKLOG 6: the WebGL glyph check ran (Linux default is WebGL) and, with correct glyphs here, kept WebGL
  await expect
    .poll(() => readFileSync(join(ud, 'logs', 'main.log'), 'utf8').match(/\[webgl-probe\] (.*)/)?.[1] ?? '', {
      timeout: 10_000,
    })
    .toMatch(/"ok":true/);
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
  // Claude bar under the terminal: busy -> only «Прервать»; idle -> /compact typed into its pane
  const bar = win.getByTestId('claude-bar');
  await expect(bar).toContainText('думает');
  await expect(bar.getByRole('button', { name: 'Сжать контекст' })).toBeDisabled();
  await expect(bar.getByRole('button', { name: 'Прервать' })).toBeVisible();
  const reg = join(fh.home, '.claude', 'sessions', `${panePid}.json`);
  writeFileSync(reg, readFileSync(reg, 'utf8').replace('"status":"busy"', '"status":"idle"'));
  await expect(bar).toContainText('простаивает', { timeout: 5000 });
  await expect(bar.getByRole('button', { name: 'Прервать' })).toHaveCount(0);
  await bar.getByRole('button', { name: 'Сжать контекст' }).click();
  await expect(win.locator('.xterm-rows').first()).toContainText('/compact', { timeout: 5000 });
  await bar.getByRole('button', { name: 'Очистить' }).click();
  await expect(win.getByRole('dialog')).toContainText('Начать разговор заново?');
  await win.screenshot({ path: join(SHOTS, '18-claude-bar.png') });
  await win.keyboard.press('Escape');
  writeFileSync(reg, readFileSync(reg, 'utf8').replace('"status":"idle"', '"status":"busy"'));
  await expect(bar).toContainText('думает', { timeout: 5000 });
  // chat title -> the chat in the «Чаты» list, selected
  await info.getByTitle('Показать в списке чатов').click();
  await expect(win.getByRole('tab', { name: 'Чаты' })).toHaveAttribute('aria-selected', 'true');
  await expect(win.getByTestId('chat-11111111-1111-4111-8111-111111111111')).toBeVisible();

  // Files and Git tabs (stage 5) for the Alpha project: tree, viewer, git groups, diff; secrets never listed
  await win.getByRole('tab', { name: 'Проекты' }).click();
  await win.getByTestId('project-Alpha').click();
  const panel = win.locator('[data-right-panel]');
  await panel.getByRole('tab', { name: 'Файлы' }).click();
  const tree = win.getByTestId('files-tree');
  await expect(tree.getByRole('button', { name: /^CLAUDE\.md/ })).toBeVisible({ timeout: 10_000 });
  await tree.getByRole('button', { name: /^CLAUDE\.md/ }).click();
  const viewer = win.getByRole('dialog');
  await expect(viewer.getByRole('heading', { name: 'Alpha' })).toBeVisible();
  await win.screenshot({ path: join(SHOTS, '14-file-viewer.png') });
  await viewer.getByRole('button', { name: 'Текст' }).click();
  await expect(viewer.locator('pre')).toContainText('# Alpha');
  await win.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await panel.getByRole('tab', { name: 'Git' }).click();
  await expect(panel).toContainText('Новые файлы', { timeout: 10_000 });
  await expect(panel).toContainText('main');
  await panel.getByRole('button', { name: /CLAUDE\.md/ }).click();
  await expect(viewer.locator('pre')).toContainText('+# Alpha');
  await win.screenshot({ path: join(SHOTS, '15-git-diff.png') });
  await win.keyboard.press('Escape');
  await setTheme(win, 'light');
  await win.screenshot({ path: join(SHOTS, '17-git-light.png') });
  await setTheme(win, 'dark');
  // a task in its own worktree (needs a first commit): created from the Git tab, listed, removed
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@example.com',
  };
  writeFileSync(join(fh.alpha, 'tool.py'), 'def run():\n    return "ok"  # done\n');
  execFileSync('git', ['-C', fh.alpha, 'add', '-A'], { env: gitEnv });
  execFileSync('git', ['-C', fh.alpha, 'commit', '-qm', 'first'], { env: gitEnv });
  await panel.getByRole('button', { name: 'Новая задача' }).click();
  const taskDlg = win.getByRole('dialog');
  await taskDlg.getByLabel('Что нужно сделать').fill('Fix login');
  await expect(taskDlg).toContainText('.claude/worktrees/fix-login');
  await taskDlg.getByLabel('Сразу открыть там новый чат').uncheck();
  await win.screenshot({ path: join(SHOTS, '21-new-task.png') });
  await taskDlg.getByRole('button', { name: 'Создать' }).click();
  const tasks = panel.getByTestId('git-tasks');
  await expect(tasks).toContainText('fix-login', { timeout: 10_000 });
  await expect(tasks).toContainText('без правок');
  expect(execFileSync('git', ['-C', fh.alpha, 'status', '--porcelain']).toString()).toBe('');
  await win.screenshot({ path: join(SHOTS, '22-git-tasks.png') });
  await tasks.getByRole('button', { name: 'Удалить задачу fix-login' }).click();
  await win.getByRole('dialog').getByRole('button', { name: 'Удалить' }).click();
  await expect(tasks).toBeHidden({ timeout: 10_000 });
  // a commit opens with its message, file list and patch
  await panel.getByRole('button', { name: 'Открыть коммит «first»' }).click();
  await expect(viewer.locator('pre')).toContainText('tool.py | 2 ++');
  await expect(viewer.locator('pre')).toContainText('+    return "ok"  # done');
  await win.keyboard.press('Escape');
  // upload from the PC: through main -> agent check -> SFTP; an existing name needs overwrite; ~/.ssh is refused
  const up = (dir: string, name: string, overwrite?: boolean) =>
    win.evaluate(
      ([dir, name, overwrite]) =>
        window.cs.invoke('file.upload', {
          dir: dir as string,
          name: name as string,
          data: new TextEncoder().encode('from the PC\n'),
          overwrite: overwrite as boolean,
        }),
      [dir, name, overwrite ?? false] as const,
    );
  expect(await up(fh.alpha, 'notes.txt')).toEqual({ ok: true, path: join(fh.alpha, 'notes.txt') });
  expect(readFileSync(join(fh.alpha, 'notes.txt'), 'utf8')).toBe('from the PC\n');
  expect(await up(fh.alpha, 'notes.txt')).toEqual({ ok: false, exists: true });
  expect((await up(fh.alpha, 'notes.txt', true)).ok).toBe(true);
  expect((await up(join(fh.home, '.ssh'), 'authorized_keys')).ok).toBe(false);
  await panel.getByRole('tab', { name: 'Файлы' }).click();
  await panel.getByRole('button', { name: 'Обновить' }).click();
  await expect(tree.getByRole('button', { name: /^notes\.txt/ })).toBeVisible();
  await win.screenshot({ path: join(SHOTS, '16-files.png') });
  // code is highlighted by its extension
  await tree.getByRole('button', { name: /^tool\.py/ }).click();
  await expect(viewer.locator('pre.hl .hljs-keyword').first()).toHaveText('def');
  await expect(viewer.locator('pre.hl .hljs-comment')).toHaveText('# done');
  await win.screenshot({ path: join(SHOTS, '26-highlight.png') });
  await win.keyboard.press('Escape');
  await panel.getByRole('tab', { name: 'Сведения' }).click();

  // palette
  await win.keyboard.press('Control+Shift+P');
  await expect(win.getByPlaceholder(/Чаты, проекты/)).toBeVisible();
  await win.keyboard.type('alp');
  await win.waitForTimeout(200);
  await win.screenshot({ path: join(SHOTS, '05-palette.png') });
  await win.keyboard.press('Escape');

  // «Настройки Claude»: the project's CLAUDE.md edited and saved on the VM; MCP keys never reach the window
  writeFileSync(
    join(fh.home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        pw: {
          command: '/usr/bin/npx',
          args: ['@playwright/mcp', '--key', 'sk-e2e-secret'],
          env: { K: 'sk-e2e-secret' },
        },
      },
    }),
  );
  await win.getByRole('button', { name: /^Настройки Claude/ }).click();
  const cs = win.locator('[data-claude-screen]');
  await expect(
    cs.getByRole('button', { name: /Папка выше: CLAUDE.md|Проект: CLAUDE.md/ }).first(),
  ).toBeVisible({
    timeout: 10_000,
  });
  await cs
    .getByRole('button', { name: /CLAUDE.md.*home\/projects\/Alpha\/CLAUDE.md/ })
    .first()
    .click();
  const editor = cs.getByRole('textbox');
  await expect(editor).toHaveValue(/# Alpha/);
  await editor.press('End');
  await editor.pressSequentially('\nПиши тесты.');
  await expect(cs).toContainText('есть несохранённые правки');
  await editor.press('Control+s');
  await expect(cs).toContainText('сохранено', { timeout: 5000 });
  expect(readFileSync(join(fh.alpha, 'CLAUDE.md'), 'utf8')).toContain('Пиши тесты.');
  await win.screenshot({ path: join(SHOTS, '19-claude-instructions.png') });
  await cs.getByRole('button', { name: /MCP-серверы/ }).click();
  await expect(cs).toContainText('npx @playwright/mcp');
  await expect(cs).not.toContainText('sk-e2e-secret');
  await win.screenshot({ path: join(SHOTS, '20-claude-mcp.png') });
  await win.keyboard.press('Escape');

  // «Расход»: the current window and the week by day, project and model (fake ccusage)
  await win.getByRole('button', { name: /окно 5 ч/ }).click();
  const usage = win.getByTestId('usage-report');
  await expect(usage).toBeVisible({ timeout: 30_000 });
  await expect(win.getByTestId('usage-window')).toContainText('35.0M');
  await expect(usage).toContainText('всего 208.0M');
  await expect(usage).toContainText('Alpha');
  await expect(usage).toContainText('opus 5.5');
  await usage.locator('svg rect').nth(5).hover();
  await expect(usage.getByRole('status')).toContainText('61.0M');
  await win.screenshot({ path: join(SHOTS, '23-usage.png') });
  await setTheme(win, 'light');
  await win.screenshot({ path: join(SHOTS, '24-usage-light.png') });
  await setTheme(win, 'dark');
  await win.keyboard.press('Escape');

  // split view: two side by side; an empty pane takes the next tab opened; back to one
  await win.getByTestId('split-menu').click();
  await win.getByRole('menuitem', { name: 'Две рядом' }).click();
  const empty = win.locator('[data-empty-pane="1"]');
  await expect(empty).toBeVisible();
  await expect(win.locator('[data-pane="0"]')).toBeVisible();
  await empty.click();
  await win.keyboard.press('Control+Shift+S');
  await expect(win.locator('[data-pane="1"]')).toBeVisible({ timeout: 10_000 });
  await expect(empty).toBeHidden();
  await win.screenshot({ path: join(SHOTS, '25-split.png') });
  await win.locator('[data-pane="0"]').click({ position: { x: 200, y: 200 } });
  await expect(win.getByTestId('claude-bar')).toBeVisible(); // focus is back on the Claude tab
  await win.keyboard.press('Control+Alt+ArrowRight');
  await expect(win.getByTestId('claude-bar')).toBeHidden(); // the shell pane has no Claude bar
  await win.keyboard.press('Control+Shift+W');
  await win.getByTestId('split-menu').click();
  await win.getByRole('menuitem', { name: 'Одна вкладка' }).click();
  await expect(win.locator('[data-pane="1"]')).toHaveCount(0);

  // system overlay (doctor) and settings
  await win.evaluate(() => document.querySelector<HTMLElement>('[data-testid="status-conn"]')?.blur());
  await win.getByRole('button', { name: /Claude claude-1.0.0/ }).click();
  await expect(win.getByText('Реестр запущенных Claude')).toBeVisible({ timeout: 30_000 });
  await win.screenshot({ path: join(SHOTS, '06-system-doctor.png') });
  await win.keyboard.press('Escape');
  await win.getByRole('button', { name: /^Настройки \(/ }).click();
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
