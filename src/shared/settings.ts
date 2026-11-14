// App settings: userData/settings.json (versioned, defaults filled in). No passwords or keys here.
import { z } from 'zod';

export const settingsSchema = z.object({
  version: z.literal(1).default(1),
  connection: z
    .object({
      /** ssh: normal mode (Windows PC -> VM). local: run the agent and tmux on this machine (dev on the VM). */
      mode: z.enum(['ssh', 'local']).default('ssh'),
      host: z.string().default('vm'),
      manual: z
        .object({
          hostname: z.string().default(''),
          port: z.number().int().min(1).max(65535).default(22),
          user: z.string().default(''),
          keyPath: z.string().default(''),
        })
        .nullable()
        .default(null),
      keepaliveSec: z.number().int().min(5).max(120).default(15),
      /** dev/tests only: tmux -L <socket> for the agent and terminals */
      tmuxSocket: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,64}$/)
        .nullable()
        .default(null),
    })
    .prefault({}),
  appearance: z
    .object({
      theme: z.enum(['system', 'dark', 'light']).default('system'),
      uiFontSize: z.number().int().min(12).max(15).default(13),
      density: z.enum(['compact', 'normal']).default('compact'),
    })
    .prefault({}),
  terminal: z
    .object({
      fontFamily: z.string().default('JetBrains Mono'),
      fontSize: z.number().int().min(8).max(28).default(15),
      lineHeight: z.number().min(1).max(1.4).default(1.2),
      cursorStyle: z.enum(['block', 'bar']).default('block'),
      // webgl: fast, own glyph atlas; dom: browser text rendering (on Windows the WebGL atlas drew glyphs too small)
      renderer: z.enum(['dom', 'webgl']).default('webgl'),
      cursorBlink: z.boolean().default(true),
      scrollback: z.number().int().min(500).max(100000).default(5000),
      ctrlCCopies: z.boolean().default(true),
      ctrlVPastes: z.boolean().default(true),
      warnMultilinePaste: z.boolean().default(true),
    })
    .prefault({}),
  startup: z
    .object({
      restoreTabs: z.boolean().default(true),
      /** start with Windows (packaged app only: app.setLoginItemSettings) */
      autostart: z.boolean().default(false),
      /** when started by autostart: stay in the tray, no window */
      startHidden: z.boolean().default(true),
    })
    .prefault({}),
  /** auto-update from GitHub Releases (stage 7, packaged app only) */
  updates: z
    .object({
      /** check on start and every 6 h, download in the background, install on quit */
      auto: z.boolean().default(true),
    })
    .prefault({}),
  /** tray icon (stage 6): closing the window hides it, connection/tunnel/notifications keep working */
  tray: z.object({ closeToTray: z.boolean().default(false) }).prefault({}),
  /** in-app notifications when a Claude session finishes (busy -> waiting/idle), BACKLOG #2 */
  notifications: z
    .object({
      toast: z.boolean().default(true),
      sound: z.boolean().default(true),
      /** 0..1 */
      volume: z.number().min(0).max(1).default(0.6),
      /** only when that session's tab is not active or the window is not focused */
      onlyBackground: z.boolean().default(true),
      /** sound file on this PC ('' = ~/.claude/sounds/sound.wav, the user's Claude Code hook sound); missing → chime */
      soundFile: z.string().max(1024).default(''),
      /** native OS notification (Windows toast); clicking it opens the session */
      system: z.boolean().default(true),
    })
    .prefault({}),
  integrations: z
    .object({
      /** PowerShell script that opens RDP to the VM (run with powershell -File); empty = not configured */
      rdpScript: z.string().default(''),
      vscodeCommand: z.string().default('code'),
      /** Host alias for VS Code Remote-SSH; empty = same as connection.host */
      remoteHost: z.string().default(''),
    })
    .prefault({}),
  hints: z
    .object({ tabCloseShown: z.boolean().default(false), trayShown: z.boolean().default(false) })
    .prefault({}),
  /** port forwarding VM -> PC (BACKLOG 10): ports re-forwarded on every connect */
  ports: z
    .object({
      pinned: z.array(z.number().int().min(1).max(65535)).max(50).default([]),
      /** toast when a new port appears in a project with an open session */
      notifyNew: z.boolean().default(true),
    })
    .prefault({}),
  /** sudo password prompts from the VM shown in the app (BACKLOG 11); needs SUDO_ASKPASS=<the app's askpass.py> */
  askpass: z
    .object({
      /** answer prompts of the app's askpass script; off = the script falls back to the GTK prompt on the VM */
      enabled: z.boolean().default(true),
    })
    .prefault({}),
  /** PC <-> VM (BACKLOG 12): reverse tunnel VM 127.0.0.1:2222 -> this PC's 127.0.0.1:22 and «Диск ПК» (winfs) */
  pcLink: z
    .object({
      /** request the reverse tunnel on connect (ssh mode only; off by default outside Windows) */
      tunnel: z.boolean().default(true),
      /** mount the folders below on connect, once the tunnel (ours or an external one) is up */
      autoMount: z.boolean().default(true),
      mounts: z
        .array(
          z
            .object({
              /** folder on the PC, C:\… */
              src: z
                .string()
                .max(260)
                .regex(/^[A-Za-z]:([\\/].*)?$/),
              /** mount point on the VM, inside the home folder (~/…) */
              dst: z
                .string()
                .max(1024)
                .regex(/^(~\/|\/).+/),
            })
            .strict(),
        )
        .max(8)
        .default([]),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsPatch = { [K in keyof Settings]?: Partial<Settings[K]> };

export function defaultSettings(platform: string = 'win32'): Settings {
  const s = settingsSchema.parse({});
  // On the Linux VM itself there is no SSH key for localhost by default: run locally.
  if (platform === 'linux') s.connection.mode = 'local';
  // the reverse tunnel goes to this machine's sshd: only meaningful on the user's Windows PC
  if (platform !== 'win32') s.pcLink = { ...s.pcLink, tunnel: false };
  // Windows: the app lives in the tray (connection, PC tunnel and notifications keep running with the window closed)
  if (platform === 'win32') s.tray = { ...s.tray, closeToTray: true };
  // Windows: native toasts instead of the in-app ones (user preference)
  if (platform === 'win32') s.notifications = { ...s.notifications, toast: false };
  // On Windows look like Windows Terminal out of the box: Cascadia Mono 12pt (16px at 100%), natural line height.
  if (platform === 'win32')
    s.terminal = { ...s.terminal, fontFamily: 'Cascadia Mono', fontSize: 16, lineHeight: 1, renderer: 'dom' };
  return s;
}

/** Validate a patched settings object; throws on invalid input (the old settings stay). */
export function applySettingsPatch(s: Settings, patch: SettingsPatch): Settings {
  const r = settingsSchema.safeParse(mergeSettings(s, patch));
  if (!r.success) throw new Error('invalid settings');
  return r.data;
}

export function parseSettings(raw: unknown, platform?: string): Settings {
  const base = defaultSettings(platform);
  if (!raw || typeof raw !== 'object') return base;
  const merged = mergeSettings(base, raw as SettingsPatch);
  const r = settingsSchema.safeParse(merged);
  return r.success ? r.data : base;
}

export function mergeSettings(s: Settings, patch: SettingsPatch): Settings {
  const out: Record<string, unknown> = { ...s };
  for (const [k, v] of Object.entries(patch)) {
    const cur = (s as Record<string, unknown>)[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object'
        ? { ...cur, ...v }
        : v;
  }
  return out as Settings;
}

export const settingsPatchSchema = z.record(z.string(), z.unknown());
