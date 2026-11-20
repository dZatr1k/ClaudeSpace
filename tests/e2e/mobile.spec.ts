/// <reference lib="dom" />
// The phone UI (docs/MOBILE.md, step 4) in Chromium at phone size, against main's core in the Vite dev server: a fake
// HOME, the real agent, a test tmux socket (src/main/mobileDev.ts). Headless, no X display needed. Screenshots of both
// themes go to docs/screenshots/m*.png.
import { chromium, expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import type { ConnState } from '../../src/shared/model';
import { ROOT, TMUX_SOCKET, killTmux, makeFakeHome, tmux } from '../integration/helpers';
import type { FakeHome } from '../integration/helpers';

const SHOTS = join(ROOT, 'docs', 'screenshots');
const PORT = 5191;
const URL = `http://127.0.0.1:${PORT}/`;

let fh: FakeHome;
let ud: string;
let vite: ChildProcess;
let browser: Browser;

async function serverUp(): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(URL)).ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('vite did not start');
}

test.beforeAll(async () => {
  execFileSync('python3', [join(ROOT, 'agent', 'build_manifest.py')], { stdio: 'ignore' });
  killTmux();
  fh = makeFakeHome();
  // a neutral prompt and tmux status line: the real user and host name must not end up in docs/screenshots
  writeFileSync(join(fh.home, '.tmux.conf'), `set -g status-right '"vm" %H:%M'\n`);
  writeFileSync(join(fh.home, '.bashrc'), "PS1='vm:\\w$ '\n");
  writeFileSync(join(fh.home, '.bash_profile'), '. ~/.bashrc\n');
  ud = mkdtempSync(join(tmpdir(), 'cs-e2e-mobile-'));
  vite = spawn(join(ROOT, 'node_modules', '.bin', 'vite'), ['--config', 'vite.mobile.config.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      MOBILE_PORT: String(PORT),
      CS_MOBILE_HOME: fh.home,
      CS_MOBILE_TMUX: TMUX_SOCKET,
      CLAUDESPACE_USER_DATA: ud,
      VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (process.env.CS_DEBUG) vite.stderr?.on('data', (b: Buffer) => process.stderr.write(b));
  await serverUp();
  browser = await chromium.launch({ chromiumSandbox: false });
});

test.afterAll(async () => {
  await browser?.close();
  vite?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  killTmux();
  fh?.cleanup();
  if (ud) rmSync(ud, { recursive: true, force: true });
});

async function phone(
  theme: 'dark' | 'light',
): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 892 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: theme,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto(URL);
  return { ctx, page, errors };
}

/** screenshots without toasts and after the 140 ms open animation of a sheet or dialog */
async function shot(page: Page, name: string) {
  for (const t of await page.locator('[aria-live="polite"] > button').all())
    await t.click({ timeout: 1000 }).catch(() => undefined);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** R-03: nothing wider than the screen */
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

const simulate = (page: Page, state: ConnState | null) =>
  page.evaluate(
    (s) => (window as unknown as { csDev: { simulate(x: unknown): void } }).csDev.simulate(s),
    state,
  );

/** Claude registered for the pane of a session (the agent reads ~/.claude/sessions), like the desktop e2e does */
function registerClaude(session: string, status: string, chatId = '11111111-1111-4111-8111-111111111111') {
  const [paneId, panePid] = tmux('list-panes', '-t', `=${session}`, '-F', '#{pane_id} #{pane_pid}')
    .trim()
    .split(' ');
  const procStart = readFileSync(`/proc/${panePid}/stat`, 'utf8').split(')').pop()?.trim().split(' ')[19];
  writeFileSync(
    join(fh.home, '.claude', 'sessions', `${panePid}.json`),
    JSON.stringify({
      pid: Number(panePid),
      sessionId: chatId,
      cwd: fh.alpha,
      procStart,
      status,
      statusUpdatedAt: Date.now() - 125_000,
      tmux: `${session}:@1.${paneId}`,
    }),
  );
}

test('phone: setup, host key, lists, a chat with the key row and the Claude strip, settings', async () => {
  const { ctx, page, errors } = await phone('dark');

  // first run: no host yet -> setup with the phone key
  await expect(page.getByRole('heading', { name: 'Подключение к VM' })).toBeVisible();
  await expect(page.getByTestId('phone-key')).toContainText('ssh-ed25519 ');
  await page.getByRole('button', { name: 'Подключиться' }).click();
  await expect(page.getByRole('alert')).toHaveText('Укажите адрес VM и пользователя');
  await page.getByLabel('Адрес VM').fill('vm');
  await page.getByLabel('Пользователь').fill('dev');
  await noOverflow(page);
  await shot(page, 'm01-setup');

  // connect: local transport, the agent installs into the fake HOME, the lists arrive
  await page.getByRole('button', { name: 'Подключиться' }).click();
  await expect(page.getByTestId('conn-badge')).toHaveText('На связи', { timeout: 30_000 });

  // states the local transport never reaches, shown through the dev bridge
  await simulate(page, {
    kind: 'needs-user',
    reason: 'hostkey-new',
    fingerprint: 'SHA256:Qm9vdHN0cmFwIGEgdGVzdCBob3N0IGtleSBoZXJlIQ',
    host: 'vm:2222',
  });
  await expect(page.getByRole('heading', { name: 'Первое подключение к этой VM' })).toBeVisible();
  await expect(page.getByTestId('host-fingerprint')).toHaveText(
    'SHA256:Qm9vdHN0cmFwIGEgdGVzdCBob3N0IGtleSBoZXJlIQ',
  );
  await noOverflow(page);
  await shot(page, 'm02-hostkey');
  await page.getByRole('button', { name: 'Отпечаток совпадает, подключиться' }).click();
  // a changed key: no way to trust it here, only to forget the old one after a confirmation
  await simulate(page, {
    kind: 'needs-user',
    reason: 'hostkey-mismatch',
    fingerprint: 'SHA256:other',
    host: 'vm',
  });
  await expect(page.getByRole('heading', { name: 'Ключ сервера изменился' })).toBeVisible();
  await expect(page.getByRole('button', { name: /подключиться/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Забыть старый ключ…' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Забыть ключ сервера?');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Забыть ключ' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await simulate(page, { kind: 'needs-user', reason: 'agent-missing-deps', detail: 'На VM нет tmux' });
  await expect(page.getByText('На VM нет tmux')).toBeVisible();
  await page.getByRole('button', { name: 'Повторить' }).click();
  await simulate(page, { kind: 'needs-user', reason: 'auth-rejected', detail: 'SHA256:x' });
  await expect(page.getByRole('heading', { name: 'VM не приняла ключ телефона' })).toBeVisible();
  await page.getByRole('button', { name: 'Копировать ключ' }).click();
  await expect(page.getByText('Скопировано')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^ssh-ed25519 /);
  await page.getByRole('button', { name: 'Изменить настройки' }).click();
  await expect(page.getByRole('heading', { name: 'Подключение к VM' })).toBeVisible();
  await simulate(page, null);
  await expect(page.getByRole('heading', { name: 'Последние чаты' })).toBeVisible();
  await expect(page.getByTestId('chat-11111111-1111-4111-8111-111111111111')).toContainText('Починка сборки');

  // new chat in a project: the sheet, then the chat screen with the terminal of the new session
  await page.getByRole('button', { name: 'Новый чат…' }).click();
  await expect(page.getByRole('dialog', { name: 'Новый чат в проекте' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: /Alpha/ }).click();
  const term = page.getByTestId('terminal');
  await expect(term.locator('.xterm-rows')).toContainText('fake claude', { timeout: 15_000 });
  const session = tmux('list-sessions', '-F', '#{session_name}').trim().split('\n')[0] as string;
  expect(session).toMatch(/^Alpha/);
  // the phone's tmux client carries the app id the agent routes by (agent/cclib/route.py)
  const pid = tmux('list-clients', '-t', `=${session}`, '-F', '#{client_pid}').trim();
  expect(
    readFileSync(`/proc/${pid}/environ`, 'utf8')
      .split('\0')
      .some((v) => /^CLAUDESPACE_APP=[0-9a-f]{16}$/.test(v)),
  ).toBe(true);

  // Claude waits for an answer: the strip says so, the answer digits appear above the keys
  registerClaude(session, 'waiting');
  const strip = page.getByTestId('claude-strip');
  await expect(strip).toContainText('ждёт ответа', { timeout: 10_000 });
  await expect(page.getByRole('group', { name: 'Ответ на запрос Claude' })).toBeVisible();
  // the input field: the text goes to the terminal whole, then Enter
  await page.getByTestId('composer').fill('проверка с телефона');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(term.locator('.xterm-rows')).toContainText('проверка с телефона', { timeout: 5000 });
  await expect(page.getByTestId('composer')).toHaveValue('');
  await noOverflow(page);
  await shot(page, 'm04-chat');

  // a file from the phone: uploaded to the VM cache, its path lands in the input field
  const pc = mkdtempSync(join(tmpdir(), 'cs-phone-'));
  writeFileSync(join(pc, 'photo notes.md'), '# notes');
  await page.getByTestId('attach-input').setInputFiles(join(pc, 'photo notes.md'));
  await expect(page.getByTestId('composer')).toHaveValue(
    /\/\.cache\/claudespace\/files\/[0-9a-f]{16}\/photo_notes\.md $/,
    {
      timeout: 10_000,
    },
  );
  rmSync(pc, { recursive: true, force: true });
  await page.getByTestId('composer').fill('');

  // the key row: arrows and Esc as a keyboard sends them (the fake Claude's terminal echoes them as ^[[A), the answer
  // digit without Enter, «Прервать» through the agent
  const rows = term.locator('.xterm-rows');
  await page.getByRole('button', { name: 'Стрелка вверх' }).click();
  await expect(rows).toContainText('^[[A', { timeout: 5000 });
  await page.getByRole('button', { name: 'Ответ 2' }).click();
  await expect(rows).toContainText('^[[A2', { timeout: 5000 });
  await strip.getByRole('button', { name: 'Прервать' }).click();
  await expect(rows).toContainText('^[[A2^[', { timeout: 5000 });
  for (const k of ['Esc', 'Tab', 'Shift+Tab', 'Стрелка влево', 'Стрелка вниз', 'Стрелка вправо', 'Enter'])
    await page.getByRole('button', { name: k, exact: true }).click();
  // direct typing: the field gives way, the keyboard types into the terminal
  await page.getByRole('button', { name: 'Набор прямо в терминал' }).click();
  await expect(page.getByTestId('composer')).toHaveCount(0);
  await page.keyboard.type('xyz');
  await expect(rows).toContainText('xyz', { timeout: 5000 });
  await page.getByRole('button', { name: 'Набор прямо в терминал' }).click();
  await expect(page.getByTestId('composer')).toBeVisible();

  // commands: busy Claude -> disabled with the reason; idle -> /compact typed into its pane
  await strip.getByRole('button', { name: 'Команды' }).click();
  const sheet = page.getByRole('dialog', { name: 'Команды' });
  await expect(sheet.getByRole('button', { name: /Сжать контекст/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  registerClaude(session, 'idle');
  await expect(strip).toContainText('простаивает', { timeout: 10_000 });
  await strip.getByRole('button', { name: 'Команды' }).click();
  await shot(page, 'm05-commands');
  await sheet.getByRole('button', { name: /Сжать контекст/ }).click();
  await expect(term.locator('.xterm-rows')).toContainText('/compact', { timeout: 5000 });
  await strip.getByRole('button', { name: 'Команды' }).click();
  await sheet.getByRole('button', { name: 'Opus /model opus', exact: true }).click();
  await expect(rows).toContainText('/model opus', { timeout: 5000 });
  await strip.getByRole('button', { name: 'Команды' }).click();
  await sheet.getByRole('button', { name: /Очистить/ }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Начать разговор заново?');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Очистить' }).click();
  await expect(rows).toContainText('/clear', { timeout: 5000 });

  // back to the list: the session row with its chat title
  await page.getByRole('button', { name: 'К списку' }).click();
  registerClaude(session, 'waiting');
  await expect(page.getByTestId(`session-${session}`)).toContainText('ждёт ответа', { timeout: 10_000 });
  await expect(page.getByText('1 ждёт')).toBeVisible();
  await noOverflow(page);
  await shot(page, 'm03-home');

  // a turn ends while the list is open (the hook line the agent tails): a toast that opens that chat
  appendFileSync(
    join(fh.home, '.cache', 'claudespace', 'events.jsonl'),
    JSON.stringify({
      ts: Date.now(),
      kind: 'input',
      sessionId: '11111111-1111-4111-8111-111111111111',
      cwd: fh.alpha,
      project: 'Alpha',
      body: 'Разрешить npm test?',
    }) + '\n',
  );
  const turn = page.getByRole('button', { name: 'Alpha: Claude ждёт ввода' });
  await expect(turn).toBeVisible({ timeout: 10_000 });
  await turn.click();
  await expect(page.getByTestId('terminal')).toBeVisible();
  await page.getByRole('button', { name: 'К списку' }).click();
  // a page that opens on a running core (the app reopened while the service kept the link) gets the lists replayed
  await page.reload();
  await expect(page.getByTestId(`session-${session}`)).toContainText('ждёт ответа', { timeout: 10_000 });
  await expect(page.getByTestId('chat-11111111-1111-4111-8111-111111111111')).toBeVisible();

  // offline after being online: a banner over the lists, not a full screen
  await simulate(page, {
    kind: 'offline',
    since: Date.now(),
    retryAt: Date.now() + 8000,
    attempt: 2,
    error: 'x',
  });
  await expect(page.getByRole('status').filter({ hasText: 'Нет связи. Повтор через' })).toBeVisible();
  await shot(page, 'm08-offline');
  await page.getByRole('button', { name: 'Повторить сейчас' }).click();
  await simulate(page, null);

  // settings: the theme switches the whole app
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('radio', { name: 'Светлая' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('radio', { name: 'Тёмная' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('radio', { name: 'Как в системе' }).click();
  // background connection: on by default, the switch turns it off and back on
  const bg = page.getByRole('switch', { name: 'Держать связь в фоне' });
  await expect(bg).toHaveAttribute('aria-checked', 'true');
  await bg.click();
  await expect(bg).toHaveAttribute('aria-checked', 'false');
  await expect(
    page.getByText('Без фона уведомления приходят, только пока приложение открыто.'),
  ).toBeVisible();
  await bg.click();
  await expect(bg).toHaveAttribute('aria-checked', 'true');
  await bg.scrollIntoViewIfNeeded();
  await shot(page, 'm10-settings-background');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); // the context asks for dark
  await page.getByRole('radio', { name: 'Светлая' }).click();
  await page.getByRole('button', { name: 'Шрифт меньше' }).click();
  await expect(page.getByText('11 px')).toBeVisible();
  await page.getByRole('button', { name: 'Шрифт больше' }).click();
  await page.getByRole('button', { name: 'Шрифт больше' }).click();
  await expect(page.getByText('13 px')).toBeVisible();
  await noOverflow(page);
  await shot(page, 'm06-settings-light');
  await page.getByRole('button', { name: 'К списку' }).click();
  await shot(page, 'm07-home-light');
  await page.getByTestId(`session-${session}`).click();
  await expect(term.locator('.xterm-rows')).toContainText('fake claude', { timeout: 15_000 });
  await shot(page, 'm09-chat-light');

  // the narrowest phones: still nothing wider than the screen
  await page.setViewportSize({ width: 360, height: 740 });
  await noOverflow(page);
  await page.setViewportSize({ width: 412, height: 892 });

  // Ctrl+B d typed straight into the terminal detaches tmux; «Подключить снова» attaches again
  await page.getByRole('button', { name: 'Набор прямо в терминал' }).click();
  await page.keyboard.press('Control+b');
  await page.keyboard.press('d');
  await expect(page.getByTestId('term-overlay')).toContainText('Терминал отключён от сессии', {
    timeout: 10_000,
  });
  await page.getByRole('button', { name: 'Подключить снова' }).click();
  await expect(page.getByTestId('term-overlay')).toHaveCount(0, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Набор прямо в терминал' }).click();

  // Ctrl from the key row + c in the field = Ctrl+C: the fake Claude exits, the session ends
  await page.getByRole('button', { name: 'Ctrl' }).click();
  await expect(page.getByRole('button', { name: 'Ctrl' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('composer').pressSequentially('с');
  await expect(page.getByTestId('term-overlay')).toContainText('Сессия завершена', { timeout: 10_000 });
  await expect(page.getByTestId('composer')).toHaveValue('');
  await page.getByTestId('term-overlay').getByRole('button', { name: 'К списку' }).click();
  await expect(page.getByRole('heading', { name: 'Последние чаты' })).toBeVisible();
  await expect(page.getByText('Сессий нет. Новый чат: кнопка внизу.')).toBeVisible({ timeout: 10_000 });

  expect(errors).toEqual([]);
  await ctx.close();
});

test('the built bundle without a bridge (the APK before step 5) says it cannot connect yet', async () => {
  const out = mkdtempSync(join(tmpdir(), 'cs-mobile-build-'));
  execFileSync(
    join(ROOT, 'node_modules', '.bin', 'vite'),
    ['build', '--config', 'vite.mobile.config.ts', '--outDir', out],
    {
      cwd: ROOT,
      env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
      stdio: 'ignore',
    },
  );
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.woff2': 'font/woff2',
  };
  const server = createServer((req, res) => {
    const rel =
      (req.url ?? '/').split('?')[0] === '/' ? 'index.html' : (req.url ?? '').slice(1).split('?')[0];
    try {
      const body = readFileSync(join(out, normalize(rel as string)));
      res.writeHead(200, { 'content-type': types[extname(rel as string)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 892 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await expect(page.getByRole('heading', { name: 'Эта сборка пока не подключается к VM' })).toBeVisible();
  await expect(page.getByText(/^ClaudeSpace \d+\.\d+\.\d+$/)).toBeVisible();
  expect(errors).toEqual([]);
  await ctx.close();
  server.close();
  rmSync(out, { recursive: true, force: true });
});
