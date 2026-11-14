// External launches on the PC: RDP script (powershell -File) and VS Code Remote-SSH (code --folder-uri).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** notConfigured: no RDP script path in the settings yet (the UI offers to open Settings → Integrations) */
export type LaunchResult = { ok: true } | { ok: false; error: string; notConfigured?: boolean };

export interface RdpOptions {
  platform?: string;
  spawnFn?: typeof spawn;
  /** how long to watch for an early failure before reporting success */
  watchMs?: number;
  log?: (...parts: unknown[]) => void;
}

/**
 * Start the RDP script exactly like a desktop shortcut would (hidden PowerShell, not detached: a detached,
 * console-less PowerShell never got to its first log line). Errors are no longer swallowed: if PowerShell exits
 * within the first seconds with a non-zero code, its stderr is returned and logged.
 */
export function launchRdp(script: string, o: RdpOptions = {}): Promise<LaunchResult> {
  const platform = o.platform ?? process.platform;
  const log = o.log ?? (() => undefined);
  if (platform !== 'win32') return Promise.resolve({ ok: false, error: 'RDP запускается только в Windows' });
  if (!script.trim())
    return Promise.resolve({
      ok: false,
      notConfigured: true,
      error: 'Скрипт RDP не задан. Укажите путь в Настройки → Интеграции',
    });
  if (!existsSync(script))
    return Promise.resolve({
      ok: false,
      error: `Файл ${script} не найден. Проверьте путь в Настройки → Интеграции`,
    });
  const args = ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script];
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: LaunchResult) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = (o.spawnFn ?? spawn)('powershell.exe', args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (e) {
      log('[rdp] spawn failed', (e as Error).message);
      finish({ ok: false, error: `Не удалось запустить RDP: ${(e as Error).message}` });
      return;
    }
    log('[rdp] started', script, 'pid', child.pid ?? '?');
    let stderr = '';
    child.stderr?.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString('utf8')).slice(-4000);
    });
    child.on('error', (e) => {
      log('[rdp] error', e.message);
      finish({ ok: false, error: `Не удалось запустить RDP: ${e.message}` });
    });
    child.on('exit', (code) => {
      const tail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
      log('[rdp] exited', code, tail);
      if (code !== 0)
        finish({
          ok: false,
          error: `RDP-скрипт завершился с кодом ${code}${tail ? `: ${tail.slice(0, 300)}` : ''}`,
        });
      else finish({ ok: true });
    });
    // still running after the watch window: tunnel + mstsc are up (or connecting) — that is success
    setTimeout(() => finish({ ok: true }), o.watchMs ?? 4000);
  });
}

/** vscode-remote://ssh-remote+<host>/<path>, path URL-encoded per segment. */
function enc(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function vscodeFolderUri(host: string, path: string): string {
  const p = path.split('/').filter(Boolean).map(enc).join('/');
  return `vscode-remote://ssh-remote+${enc(host)}/${p}`;
}

// nothing but unreserved chars and %XX: safe to pass through cmd.exe
const SAFE_URI = /^vscode-remote:\/\/ssh-remote\+[A-Za-z0-9%._~-]+(\/[A-Za-z0-9%._~-]*)*$/;

export function findVsCode(command: string, platform = process.platform, env = process.env): string | null {
  if (platform === 'win32') {
    const r = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true });
    const hit =
      r.status === 0
        ? r.stdout.split(/\r?\n/).find((l) => /\.cmd$/i.test(l.trim()) || /\.exe$/i.test(l.trim()))
        : null;
    if (hit) return hit.trim();
    const local = join(env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd');
    return existsSync(local) ? local : null;
  }
  const r = spawnSync('which', [command], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

export function launchVsCode(
  command: string,
  host: string,
  path: string,
  platform = process.platform,
): LaunchResult {
  const uri = vscodeFolderUri(host, path);
  if (!SAFE_URI.test(uri)) return { ok: false, error: 'Недопустимый путь для VS Code' };
  const exe = findVsCode(command || 'code', platform);
  if (!exe) return { ok: false, error: 'VS Code не найден. Проверьте команду в Настройки → Интеграции' };
  try {
    if (platform === 'win32' && /\.cmd$/i.test(exe)) {
      // .cmd needs cmd.exe; the URI is validated above (no spaces, quotes or shell metacharacters except %)
      spawn('cmd.exe', ['/d', '/s', '/c', `"${exe}" --folder-uri ${uri}`], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
      }).unref();
    } else {
      spawn(exe, ['--folder-uri', uri], { detached: true, stdio: 'ignore', shell: false }).unref();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Не удалось запустить VS Code: ${(e as Error).message}` };
  }
}

const SOUND_EXT = /\.(wav|mp3|ogg)$/i;
const SOUND_MAX = 5 * 1024 * 1024;

/** Default notification sound: the one the user's Claude Code hook plays (~/.claude/sounds/sound.wav). */
export function defaultSoundPath(home = homedir()): string {
  return join(home, '.claude', 'sounds', 'sound.wav');
}

/** Read a notification sound file from this PC for the renderer (decoded there with WebAudio; no CSP change). */
export function loadSound(
  configured: string,
  home = homedir(),
): { ok: boolean; path: string; data?: Uint8Array; error?: string } {
  const path = configured.trim() || defaultSoundPath(home);
  if (!SOUND_EXT.test(path)) return { ok: false, path, error: 'нужен .wav, .mp3 или .ogg' };
  try {
    const st = statSync(path);
    if (!st.isFile()) return { ok: false, path, error: 'не файл' };
    if (st.size > SOUND_MAX) return { ok: false, path, error: 'файл больше 5 МБ' };
    return { ok: true, path, data: new Uint8Array(readFileSync(path)) };
  } catch {
    return { ok: false, path, error: 'файл не найден' };
  }
}
