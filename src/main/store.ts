// userData files: settings.json, workspace.json, cache/snapshot.json. Atomic writes (tmp + rename).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Snapshot, Workspace } from '../shared/model';
import { applySettingsPatch, parseSettings } from '../shared/settings';
import type { Settings, SettingsPatch } from '../shared/settings';

export function atomicWrite(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function validWorkspace(w: unknown): w is Workspace {
  if (!w || typeof w !== 'object') return false;
  const o = w as Partial<Workspace>;
  return o.version === 1 && Array.isArray(o.tabs) && typeof o.layout === 'object' && o.layout !== null;
}

export class Store {
  private settingsCache: Settings;
  private snapTimer: NodeJS.Timeout | null = null;
  private wsTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly dir: string,
    private readonly platform: string = process.platform,
  ) {
    this.settingsCache = parseSettings(readJson(this.path('settings.json')), platform);
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  get settings(): Settings {
    return this.settingsCache;
  }

  updateSettings(patch: SettingsPatch): Settings {
    const next = applySettingsPatch(this.settingsCache, patch);
    this.settingsCache = next;
    atomicWrite(this.path('settings.json'), JSON.stringify(next, null, 2));
    return next;
  }

  workspace(): Workspace | null {
    const w = readJson(this.path('workspace.json'));
    return validWorkspace(w) ? w : null;
  }

  saveWorkspace(w: Workspace, delayMs = 500): void {
    if (!validWorkspace(w)) return;
    // only tmux tabs are restored (DESIGN §8)
    const prev = this.workspace();
    const clean: Workspace = {
      ...w,
      tabs: w.tabs.filter((t) => t.kind === 'tmux').slice(0, 50),
      window: w.window ?? prev?.window ?? null,
    };
    if (this.wsTimer) clearTimeout(this.wsTimer);
    const write = () => atomicWrite(this.path('workspace.json'), JSON.stringify(clean, null, 2));
    if (delayMs <= 0) write();
    else this.wsTimer = setTimeout(write, delayMs);
  }

  patchWindow(bounds: Workspace['window']): void {
    const w: Workspace = this.workspace() ?? {
      version: 1,
      tabs: [],
      activeTabId: null,
      layout: {
        sidebarWidth: 280,
        sidebarOpen: true,
        rightWidth: 360,
        rightOpen: true,
        rightTab: 'info',
        sidebarTab: 'projects',
      },
      window: null,
    };
    atomicWrite(this.path('workspace.json'), JSON.stringify({ ...w, window: bounds }, null, 2));
  }

  snapshot(): Snapshot | null {
    const s = readJson(this.path(join('cache', 'snapshot.json')));
    return s && typeof s === 'object' && Array.isArray((s as Snapshot).chats) ? (s as Snapshot) : null;
  }

  saveSnapshot(s: Snapshot, delayMs = 2000): void {
    if (this.snapTimer) clearTimeout(this.snapTimer);
    this.snapTimer = setTimeout(
      () => atomicWrite(this.path(join('cache', 'snapshot.json')), JSON.stringify(s)),
      delayMs,
    );
  }

  flush(): void {
    if (this.wsTimer) {
      clearTimeout(this.wsTimer);
      this.wsTimer = null;
    }
  }
}
