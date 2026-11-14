// BrowserWindow with security defaults: contextIsolation, sandbox, no nodeIntegration, CSP, no navigation.
import { BrowserWindow, nativeTheme, screen, session, shell } from 'electron';
import { join } from 'node:path';
import type { WindowBounds } from '../shared/model';

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

export function installCsp(dev: boolean): void {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    // dev server needs ws: for HMR and inline preamble of @vitejs/plugin-react
    const csp = dev
      ? CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace(
          "connect-src 'self'",
          "connect-src 'self' ws://localhost:* http://localhost:*",
        )
      : CSP;
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === 'clipboard-sanitized-write'),
  );
}

function visible(b: WindowBounds): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return (
      b.x < a.x + a.width - 50 && b.x + b.width > a.x + 50 && b.y >= a.y - 10 && b.y < a.y + a.height - 50
    );
  });
}

export function createWindow(opts: {
  preload: string;
  bounds: WindowBounds | null;
  dev: boolean;
  /** false: started hidden in the tray (autostart) */
  show?: boolean;
}): BrowserWindow {
  const b = opts.bounds && visible(opts.bounds) ? opts.bounds : null;
  const dark = nativeTheme.shouldUseDarkColors;
  const win = new BrowserWindow({
    width: b?.width ?? 1440,
    height: b?.height ?? 900,
    x: b?.x,
    y: b?.y,
    minWidth: 960,
    minHeight: 600,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: overlay(dark, true), // the renderer starts with the splash
    backgroundColor: dark ? '#121110' : '#FBFAF8',
    title: 'ClaudeSpace',
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: opts.dev,
    },
  });
  if (b?.maximized) win.maximize();
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (opts.show !== false) win.once('ready-to-show', () => win.show());
  return win;
}

export function rendererEntry(win: BrowserWindow): Promise<void> {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) return win.loadURL(devUrl);
  return win.loadFile(join(__dirname, '../renderer/index.html'));
}

/** caption buttons (Windows): title bar colour, or the page background while the startup splash covers it */
function overlay(dark: boolean, splash: boolean) {
  const bg = splash ? (dark ? '#121110' : '#FBFAF8') : dark ? '#191816' : '#F3F1EE';
  return { color: bg, symbolColor: dark ? '#EDE9E4' : '#1D1B19', height: 36 };
}

export function setOverlayTheme(win: BrowserWindow, dark: boolean, splash = false): void {
  try {
    win.setTitleBarOverlay(overlay(dark, splash));
  } catch {
    /* not supported on this platform */
  }
}
