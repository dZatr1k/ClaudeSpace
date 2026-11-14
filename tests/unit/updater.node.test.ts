import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Updater, updateErrorText } from '../../src/main/updater';
import type { UpdaterLike } from '../../src/main/updater';
import { APP_ID } from '../../src/shared/app';
import { defaultSettings } from '../../src/shared/settings';
import type { Settings } from '../../src/shared/settings';

const ROOT = join(__dirname, '..', '..');

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = true;
  logger: unknown = null;
  checks = 0;
  installs: [boolean | undefined, boolean | undefined][] = [];
  next: () => Promise<unknown> = async () => {
    this.emit('checking-for-update');
    this.emit('update-not-available', { version: '0.1.0' });
    return {};
  };
  checkForUpdates() {
    this.checks++;
    return this.next();
  }
  quitAndInstall(a?: boolean, b?: boolean) {
    this.installs.push([a, b]);
  }
}

function make(o: { enabled?: boolean; settings?: Settings } = {}) {
  const fake = new FakeUpdater();
  const settings = o.settings ?? defaultSettings('win32');
  const order: string[] = [];
  const u = new Updater({
    enabled: o.enabled ?? true,
    current: '0.1.0',
    settings: () => settings,
    log: () => undefined,
    load: async () => fake,
    beforeInstall: async () => {
      order.push('cleanup');
    },
    installFailed: () => order.push('failed'),
    firstDelayMs: 10,
    intervalMs: 40,
    installWatchMs: 30,
  });
  return { u, fake, order, settings };
}

describe('packaging', () => {
  it('electron-builder appId = AppUserModelID of the packaged app', () => {
    const yml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(yml).toMatch(new RegExp(`^appId: ${APP_ID.replace(/\./g, '\\.')}$`, 'm'));
    // unsigned releases: the updater must not verify a publisher
    expect(yml).not.toMatch(/publisherName/);
    expect(yml).toMatch(/verifyUpdateCodeSignature: false/);
  });
  it('the GitHub repository is configured in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.repository.url).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/);
    expect(pkg.dependencies['electron-updater']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('updater', () => {
  it('disabled in dev: no load, no checks', async () => {
    const { u, fake } = make({ enabled: false });
    await u.start();
    expect(u.state).toMatchObject({ status: 'disabled', disabledReason: 'dev', current: '0.1.0' });
    await u.check();
    expect(fake.checks).toBe(0);
    expect(await u.installNow()).toBe(false);
  });

  it('configures electron-updater and checks on start and on the interval when auto is on', async () => {
    const { u, fake } = make();
    await u.start();
    expect(fake).toMatchObject({ autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: false });
    await vi.waitFor(() => expect(fake.checks).toBeGreaterThanOrEqual(2), { timeout: 2000 });
    expect(u.state.status).toBe('none');
    expect(u.state.lastCheck).toBeGreaterThan(0);
    u.dispose();
  });

  it('auto off: no automatic checks, the button still works', async () => {
    const settings = defaultSettings('win32');
    settings.updates.auto = false;
    const { u, fake } = make({ settings });
    await u.start();
    await new Promise((r) => setTimeout(r, 120));
    expect(fake.checks).toBe(0);
    await u.check();
    expect(fake.checks).toBe(1);
    u.dispose();
  });

  it('found -> downloading -> ready; restart cleans up first, then quitAndInstall(silent, run after)', async () => {
    const settings = defaultSettings('win32');
    settings.updates.auto = false;
    const { u, fake, order } = make({ settings });
    await u.start();
    const states: string[] = [];
    u.on('state', (s) => states.push(s.status));
    fake.next = async () => {
      fake.emit('checking-for-update');
      fake.emit('update-available', { version: '0.2.0' });
      fake.emit('download-progress', { percent: 42.4 });
      return {};
    };
    await u.check();
    expect(u.state).toMatchObject({ status: 'downloading', version: '0.2.0', percent: 42 });
    // no second check while downloading
    await u.check();
    expect(fake.checks).toBe(1);
    fake.emit('update-downloaded', { version: '0.2.0' });
    expect(u.state).toMatchObject({ status: 'ready', version: '0.2.0' });
    // a later error (e.g. a failed periodic check) does not hide the downloaded update
    fake.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
    expect(u.state.status).toBe('ready');
    expect(states).toEqual(expect.arrayContaining(['checking', 'available', 'downloading', 'ready']));
    expect(await u.installNow()).toBe(true);
    expect(order).toEqual(['cleanup']);
    expect(fake.installs).toEqual([[true, true]]);
    // the installer did not take over (the real app would have quit by now): restart instead of staying half-closed
    await vi.waitFor(() => expect(order).toEqual(['cleanup', 'failed']), { timeout: 1000 });
  });

  it('errors are short and readable', async () => {
    const { u, fake } = make();
    await u.start();
    u.dispose();
    fake.next = async () => {
      throw new Error('getaddrinfo ENOTFOUND github.com\nstack…');
    };
    await u.check();
    expect(u.state).toMatchObject({ status: 'error', error: 'нет связи с GitHub' });
    expect(updateErrorText(new Error('HttpError: 404 \n"method: GET url: https://github.com/…"'))).toBe(
      'релизы не найдены (404)',
    );
    expect(updateErrorText('x'.repeat(300))).toHaveLength(201);
  });
});
