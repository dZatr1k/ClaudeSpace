import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applySettingsPatch, defaultSettings, parseSettings } from '../../src/shared/settings';
import { Store } from '../../src/main/store';
import { backoffDelay } from '../../src/main/connection';
import { launchRdp, vscodeFolderUri } from '../../src/main/launch';
import { listHosts, resolveHost } from '../../src/main/ssh/config';
import { validateParams } from '../../src/shared/protocol';

describe('settings', () => {
  it('defaults per platform', () => {
    expect(defaultSettings('win32').connection.mode).toBe('ssh');
    expect(defaultSettings('linux').connection.mode).toBe('local');
    const s = defaultSettings('win32');
    expect(s.appearance.theme).toBe('system');
    expect(s.terminal).toMatchObject({
      fontFamily: 'Cascadia Mono',
      fontSize: 16,
      lineHeight: 1,
      renderer: 'dom',
    });
    expect(defaultSettings('linux').terminal).toMatchObject({
      fontFamily: 'JetBrains Mono',
      fontSize: 15,
      lineHeight: 1.2,
    });
    // no personal defaults: RDP script and PC disks are configured by the user
    expect(s.integrations.rdpScript).toBe('');
    expect(s.pcLink.mounts).toEqual([]);
    expect(s.updates.auto).toBe(true);
  });
  it('explicit values in an existing settings file survive the neutral defaults', () => {
    // the Store always writes the whole settings object, so a file written by an older version keeps its values
    const old = {
      version: 1,
      integrations: { rdpScript: 'C:\\Scripts\\rdp.ps1', vscodeCommand: 'code', remoteHost: '' },
      pcLink: { tunnel: true, autoMount: true, mounts: [{ src: 'C:\\Data', dst: '~/winfs/V' }] },
    };
    const s = parseSettings(old, 'win32');
    expect(s.integrations.rdpScript).toBe('C:\\Scripts\\rdp.ps1');
    expect(s.pcLink.mounts).toEqual([{ src: 'C:\\Data', dst: '~/winfs/V' }]);
    expect(s.updates.auto).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'cs-store-'));
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(old));
    const st = new Store(dir, 'win32');
    st.updateSettings({ updates: { auto: false } });
    const saved = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(saved.integrations.rdpScript).toBe('C:\\Scripts\\rdp.ps1');
    expect(saved.pcLink.mounts).toHaveLength(1);
    expect(saved.updates.auto).toBe(false);
    rmSync(dir, { recursive: true });
  });
  it('fills missing fields, ignores junk', () => {
    expect(parseSettings({ appearance: { theme: 'light' } }, 'win32').appearance).toMatchObject({
      theme: 'light',
      uiFontSize: 13,
    });
    expect(parseSettings('garbage', 'win32').connection.host).toBe('vm');
    expect(parseSettings({ terminal: { fontSize: 'big' } }, 'win32').terminal.fontSize).toBe(16);
  });
  it('invalid patch throws and keeps the old settings', () => {
    const s = defaultSettings('win32');
    expect(() => applySettingsPatch(s, { terminal: { fontSize: 999 } })).toThrow();
    expect(applySettingsPatch(s, { terminal: { fontSize: 16 } }).terminal.fontSize).toBe(16);
  });
  it('store: atomic settings, workspace keeps window bounds and only tmux tabs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-store-'));
    const st = new Store(dir, 'win32');
    st.updateSettings({ appearance: { theme: 'dark' } });
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).appearance.theme).toBe('dark');
    st.patchWindow({ x: 1, y: 2, width: 1000, height: 700, maximized: false });
    const layout = {
      sidebarWidth: 300,
      sidebarOpen: true,
      rightWidth: 360,
      rightOpen: false,
      rightTab: 'info' as const,
      sidebarTab: 'chats' as const,
    };
    st.saveWorkspace(
      {
        version: 1,
        tabs: [
          { id: 'a', kind: 'tmux', session: 'S', chatId: null, cwd: '/x', title: 'S' },
          { id: 'b', kind: 'shell', session: null, chatId: null, cwd: '/x', title: 'sh' },
        ],
        activeTabId: 'a',
        layout,
        window: null,
      },
      0,
    );
    const w = st.workspace();
    expect(w?.tabs.map((t) => t.id)).toEqual(['a']);
    expect(w?.window).toEqual({ x: 1, y: 2, width: 1000, height: 700, maximized: false });
    expect(w?.layout.sidebarWidth).toBe(300);
    writeFileSync(join(dir, 'workspace.json'), '{"version":2}');
    expect(st.workspace()).toBeNull();
    rmSync(dir, { recursive: true });
  });
});

describe('misc main helpers', () => {
  it('backoff 1,2,4,8,16,30,30 s ±20%', () => {
    expect(backoffDelay(0, () => 0.5)).toBe(1000);
    expect(backoffDelay(3, () => 0.5)).toBe(8000);
    expect(backoffDelay(10, () => 0.5)).toBe(30000);
    expect(backoffDelay(0, () => 0)).toBe(800);
    expect(backoffDelay(0, () => 1)).toBe(1200);
  });
  it('vscode remote URI is encoded per segment and safe for cmd.exe', () => {
    expect(vscodeFolderUri('vm', '/home/claude/projects/X')).toBe(
      'vscode-remote://ssh-remote+vm/home/claude/projects/X',
    );
    expect(vscodeFolderUri('vm', "/home/c/my proj & (1)!'")).toBe(
      'vscode-remote://ssh-remote+vm/home/c/my%20proj%20%26%20%281%29%21%27',
    );
  });
  it('RDP without a configured script asks to configure it', async () => {
    await expect(launchRdp('', { platform: 'win32' })).resolves.toMatchObject({
      ok: false,
      notConfigured: true,
    });
    await expect(launchRdp('C:\\missing\\rdp.ps1', { platform: 'win32' })).resolves.toEqual({
      ok: false,
      error: 'Файл C:\\missing\\rdp.ps1 не найден. Проверьте путь в Настройки → Интеграции',
    });
  });
  it('RDP outside Windows is a clear error', async () => {
    await expect(launchRdp('C:\\x.ps1', { platform: 'linux' })).resolves.toEqual({
      ok: false,
      error: 'RDP запускается только в Windows',
    });
  });
  it('RDP: early failure of the script is reported with its stderr, a running script is success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-rdp-'));
    const script = join(dir, 'rdp.ps1');
    writeFileSync(script, '');
    const fake = (behave: (c: EventEmitter & { stderr: EventEmitter }) => void) =>
      ((cmd: string, args: string[]) => {
        expect(cmd).toBe('powershell.exe');
        expect(args).toEqual([
          '-NoProfile',
          '-WindowStyle',
          'Hidden',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
        ]);
        const c = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), pid: 42 });
        setTimeout(() => behave(c), 5);
        return c;
      }) as unknown as typeof spawn;
    try {
      const failed = await launchRdp(script, {
        platform: 'win32',
        watchMs: 500,
        spawnFn: fake((c) => {
          c.stderr.emit('data', Buffer.from('Add-Type : boom\r\n'));
          c.emit('exit', 1);
        }),
      });
      expect(failed).toEqual({ ok: false, error: 'RDP-скрипт завершился с кодом 1: Add-Type : boom' });
      const running = await launchRdp(script, {
        platform: 'win32',
        watchMs: 50,
        spawnFn: fake(() => undefined),
      });
      expect(running).toEqual({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('ssh config: hosts without wildcards, resolve values', () => {
    const text =
      'Host *\n  ServerAliveInterval 30\nHost vm vm2\n  HostName 203.0.113.10\n  User claude\n  Port 2200\n  IdentityFile ~/.ssh/id_ed25519\nHost winpc\n  HostName localhost\n';
    expect(listHosts(text)).toEqual(['vm', 'vm2', 'winpc']);
    const r = resolveHost(text, 'vm', 'me');
    expect(r).toMatchObject({ hostname: '203.0.113.10', user: 'claude', port: 2200 });
    expect(r.identityFiles[0]).toMatch(/id_ed25519$/);
    expect(resolveHost(text, 'winpc', 'me')).toMatchObject({ user: 'me', port: 22 });
  });
  it('protocol params are validated in main', () => {
    expect(() => validateParams('kill_session', { session: 'a;b' })).toThrow();
    expect(() => validateParams('chat_preview', { chatId: '../x' })).toThrow();
    expect(() => validateParams('new_session', { cwd: '/x', command: 'bash' })).toThrow();
    expect(validateParams('list_chats', { archived: true })).toEqual({ archived: true });
    expect(() => validateParams('ping', { extra: 1 })).toThrow();
  });
});

describe('notification sound file', () => {
  it('reads the default hook sound, validates extension and existence', async () => {
    const { loadSound, defaultSoundPath } = await import('../../src/main/launch');
    const home = mkdtempSync(join(tmpdir(), 'cs-sound-'));
    try {
      expect(defaultSoundPath(home)).toBe(join(home, '.claude', 'sounds', 'sound.wav'));
      expect(loadSound('', home)).toMatchObject({ ok: false, error: 'файл не найден' });
      mkdirSync(join(home, '.claude', 'sounds'), { recursive: true });
      writeFileSync(defaultSoundPath(home), Buffer.from('RIFF....WAVE'));
      const r = loadSound('', home);
      expect(r.ok).toBe(true);
      expect(r.data?.length).toBe(12);
      expect(loadSound(join(home, 'x.exe'), home)).toMatchObject({
        ok: false,
        error: 'нужен .wav, .mp3 или .ogg',
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
