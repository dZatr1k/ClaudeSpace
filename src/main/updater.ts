// Auto-update from GitHub Releases (stage 7) with electron-updater: check on start and every 6 h, download in the
// background, then the renderer shows "restart and update" / "later". "Later" = installed silently when the app quits.
// The feed (owner/repo) is baked into app-update.yml by electron-builder from package.json "repository".
// Releases are unsigned: no publisherName in the config, so electron-updater skips signature verification.
import { EventEmitter } from 'node:events';
import type { Settings } from '../shared/settings';
import type { UpdateState } from '../shared/update';
import { initialUpdateState } from '../shared/update';

/** the part of electron-updater's AppUpdater we use (a fake in tests) */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  logger: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- electron-updater's typed events, narrowed below
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdaterDeps {
  /** packaged app on a platform electron-updater can update (NSIS on Windows, AppImage on Linux) */
  enabled: boolean;
  disabledReason?: 'dev' | 'platform';
  current: string;
  settings: () => Settings;
  log: (...parts: unknown[]) => void;
  /** electron-updater's autoUpdater, loaded only when enabled */
  load: () => Promise<UpdaterLike>;
  /** quitApp's cleanup (unmount PC disks, close forwards) without quitting; then the updater quits the app */
  beforeInstall: () => Promise<void>;
  /** the installer did not take over (the app is already cleaned up): restart the app instead of staying half-closed */
  installFailed: () => void;
  /** first automatic check after start */
  firstDelayMs?: number;
  installWatchMs?: number;
  intervalMs?: number;
  now?: () => number;
}

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** short, single-line error text for the UI (electron-updater errors can carry whole HTTP responses) */
export function updateErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const first = msg.split(/\r?\n/)[0] ?? '';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|net::ERR_/i.test(first))
    return 'нет связи с GitHub';
  if (/\b404\b/.test(first)) return 'релизы не найдены (404)';
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}

export class Updater extends EventEmitter {
  private st: UpdateState;
  private u: UpdaterLike | null = null;
  private timers: NodeJS.Timeout[] = [];
  private checking: Promise<void> | null = null;

  constructor(private readonly deps: UpdaterDeps) {
    super();
    this.st = {
      ...initialUpdateState,
      current: deps.current,
      status: deps.enabled ? 'idle' : 'disabled',
      disabledReason: deps.enabled ? null : (deps.disabledReason ?? 'dev'),
    };
  }

  get state(): UpdateState {
    return this.st;
  }

  private set(p: Partial<UpdateState>) {
    this.st = { ...this.st, ...p };
    this.emit('state', this.st);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async start(): Promise<void> {
    if (!this.deps.enabled) {
      this.deps.log('[update] disabled:', this.st.disabledReason);
      return;
    }
    try {
      this.u = await this.deps.load();
    } catch (e) {
      this.deps.log('[update] electron-updater failed to load:', (e as Error).message);
      this.set({ status: 'error', error: updateErrorText(e) });
      return;
    }
    const u = this.u;
    u.autoDownload = true;
    u.autoInstallOnAppQuit = true;
    u.allowPrerelease = false;
    const log = this.deps.log;
    u.logger = {
      info: (m: unknown) => log('[update]', String(m)),
      warn: (m: unknown) => log('[update] warn:', String(m)),
      error: (m: unknown) => log('[update] error:', String(m)),
      debug: () => undefined,
    };
    u.on('checking-for-update', () => this.set({ status: 'checking', error: null }));
    u.on('update-not-available', () =>
      this.set({ status: 'none', version: null, percent: null, lastCheck: this.now() }),
    );
    u.on('update-available', (info: { version: string }) =>
      this.set({
        status: 'available',
        version: info.version,
        percent: 0,
        lastCheck: this.now(),
        error: null,
      }),
    );
    u.on('download-progress', (p: { percent: number }) =>
      this.set({ status: 'downloading', percent: Math.round(p.percent) }),
    );
    u.on('update-downloaded', (info: { version: string }) => {
      log('[update] downloaded', info.version);
      this.set({ status: 'ready', version: info.version, percent: 100, error: null });
    });
    u.on('error', (e: Error) => {
      // a failed check/download: keep a downloaded update usable, otherwise show the error
      if (this.st.status === 'ready') return;
      this.set({ status: 'error', error: updateErrorText(e), lastCheck: this.now(), percent: null });
    });
    const auto = () => this.deps.settings().updates.auto;
    this.timers.push(
      setTimeout(() => {
        if (auto()) void this.check();
      }, this.deps.firstDelayMs ?? 15_000),
      setInterval(() => {
        if (auto()) void this.check();
      }, this.deps.intervalMs ?? CHECK_INTERVAL_MS),
    );
  }

  /** check now (button or timer); no-op while a check runs or an update is downloading/downloaded */
  check(): Promise<void> {
    const u = this.u;
    if (!u || this.checking) return this.checking ?? Promise.resolve();
    if (this.st.status === 'downloading' || this.st.status === 'ready') return Promise.resolve();
    this.set({ status: 'checking', error: null });
    this.checking = u
      .checkForUpdates()
      .then(
        (r) => {
          // null: the updater is inactive (should not happen when enabled)
          if (r == null && this.st.status === 'checking') this.set({ status: 'none', lastCheck: this.now() });
        },
        (e: unknown) => {
          if (this.st.status !== 'ready')
            this.set({ status: 'error', error: updateErrorText(e), lastCheck: this.now() });
        },
      )
      .finally(() => {
        this.checking = null;
      });
    return this.checking;
  }

  /** "restart and update": clean up like a normal quit, then let the installer replace the app and start it again */
  async installNow(): Promise<boolean> {
    if (!this.u || this.st.status !== 'ready') return false;
    this.deps.log('[update] install now', this.st.version);
    await this.deps.beforeInstall();
    // silent NSIS run (one-click installer, per user), then start the new version
    this.u.quitAndInstall(true, true);
    // quitAndInstall quits on the next tick when the installer started; still here after a while = it did not
    setTimeout(() => {
      this.deps.log('[update] installer did not start, restarting the app');
      this.deps.installFailed();
    }, this.deps.installWatchMs ?? 8000).unref?.();
    return true;
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
