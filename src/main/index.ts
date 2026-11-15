// ClaudeSpace main process: lifecycle, single instance, window, connection, terminals, IPC.
import { app, clipboard, dialog, Menu, nativeTheme, Notification, powerMonitor, shell } from 'electron';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import type { BrowserWindow } from 'electron';
import type { Workspace } from '../shared/model';
import { MAIN_ONLY_METHODS, METHODS, methodTimeout, PROTOCOL } from '../shared/protocol';
import type { Method } from '../shared/protocol';
import type { Handlers } from './ipc';
import { registerIpc } from './ipc';
import { initLog, log, recentLog } from './log';
import { Connection } from './connection';
import { RpcError } from './agent/rpc';
import { readBundledManifest } from './agent/installer';
import { TerminalManager } from './terminals';
import { PcLink } from './pclink';
import { PortForwarder } from './ports';
import { AskpassBroker } from './askpass';
import type { AskpassRequest } from '../shared/askpass';
import { mapLocalUrl, parseLocalUrl, portUrl } from '../shared/ports';
import type { PortOpenResult } from '../shared/ipc';
import type { VmPort } from '../shared/protocol';
import type { Transport } from './transport/types';
import { loadClientId, Store } from './store';
import { DataCache } from './snapshot';
import { uploadImage } from './images';
import { FileTransfers } from './files';
import { createWindow, installCsp, rendererEntry, setOverlayTheme } from './window';
import { AppTray } from './tray';
import { Updater } from './updater';
import type { UpdaterLike } from './updater';
import { APP_ID } from '../shared/app';
import { launchRdp, launchVsCode, loadSound } from './launch';
import { defaultConfigPath, listHosts, readConfig, resolveHost } from './ssh/config';
import { methodSchemas } from '../shared/protocol';
import type { Usage } from '../shared/model';

if (process.env.CLAUDESPACE_USER_DATA) app.setPath('userData', process.env.CLAUDESPACE_USER_DATA);
const dev = !app.isPackaged;
const debugTools = dev || process.env.CLAUDESPACE_DEBUG === '1';

// Windows toasts need an AppUserModelID matching the Start-menu shortcut: the installer (electron-builder) sets the
// appId on it, so the packaged app uses APP_ID. A dev Electron has no shortcut: use the exe path, as Electron
// recommends — otherwise Windows silently drops the notifications.
app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// started by Windows autostart with "start hidden": stay in the tray
const startHidden = process.argv.includes('--hidden');

const resourcesDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources');
const bundleDir = join(resourcesDir, 'agent');
const userData = app.getPath('userData');
initLog(join(userData, 'logs'));
const store = new Store(userData);
const cache = new DataCache();
cache.load(store.snapshot());

let win: BrowserWindow | null = null;
let tray: AppTray | null = null;
let quitting = false;
let cleanedUp = false;
const send = (channel: string, data: unknown) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
};

const conn = new Connection({
  settings: () => store.settings,
  bundleDir,
  ptyHelper: join(resourcesDir, 'ptyhelper.py'),
  appKnownHosts: join(userData, 'known_hosts'),
  log,
});

const terminals = new TerminalManager(
  {
    data: (tabId, data) => send('term.data', { tabId, data }),
    exit: (tabId, code, signal) => send('term.exit', { tabId, code, signal }),
  },
  () => conn.transport,
  () => store.settings.connection.tmuxSocket,
);

const pclink = new PcLink({
  conn,
  settings: () => store.settings,
  clientId: loadClientId(userData),
  log,
}).attach();
pclink.on('state', (s) => send('pclink.state', s));

const ports = new PortForwarder({ transport: () => conn.transport, settings: () => store.settings, log });
ports.on('state', (s) => send('ports.state', s));
conn.on('online', ({ transport }: { transport: Transport }) => {
  if (transport.kind !== 'local') ports.resetDirect();
  void ports.restorePinned();
});
conn.on('agent-event', (event: string, data: unknown) => {
  if (event === 'ports_changed') ports.setVmPorts((data as { ports: VmPort[] }).ports);
});

// auto-update: packaged NSIS install on Windows or an AppImage on Linux; dev and other builds — off
const updatable = app.isPackaged && (process.platform === 'win32' || !!process.env.APPIMAGE);
const updater = new Updater({
  enabled: updatable,
  disabledReason: app.isPackaged ? 'platform' : 'dev',
  current: app.getVersion(),
  settings: () => store.settings,
  log,
  // electron-updater is CommonJS with `autoUpdater` as a lazy getter: an ESM import does not see it as a named
  // export (it is undefined there) — take it from the CJS module object instead
  load: async () => {
    const m = (await import('electron-updater')) as unknown as {
      autoUpdater?: UpdaterLike;
      default?: { autoUpdater?: UpdaterLike };
    };
    const u = m.autoUpdater ?? m.default?.autoUpdater;
    if (!u) throw new Error('electron-updater: autoUpdater not found');
    return u;
  },
  beforeInstall: () => cleanupForQuit(),
  installFailed: () => {
    app.relaunch();
    app.quit();
  },
});
updater.on('state', (s) => send('update.state', s));

const askpass = new AskpassBroker({
  conn,
  settings: () => store.settings,
  log,
  attention: (req) => askpassAttention(req),
}).attach();

/** a sudo prompt: the window must come to front even from the tray; a notification if the user was elsewhere */
function askpassAttention(req: AskpassRequest) {
  if (!win || win.isDestroyed()) return;
  const wasFocused = win.isVisible() && win.isFocused();
  if (wasFocused) return;
  showWindow();
  win.flashFrame(true);
  win.once('focus', () => win?.flashFrame(false));
  if (store.settings.notifications.system)
    showSystemNotification({
      title: req.session ? `sudo просит пароль (${req.session})` : 'sudo просит пароль',
      body: (req.command ?? req.prompt).slice(0, 300),
      session: '',
    });
}

async function forwardPort(vmPort: number, url?: string, open = false): Promise<PortOpenResult> {
  try {
    const u = url ? parseLocalUrl(url) : null;
    if (url && !u) return { ok: false, error: 'это не адрес localhost' };
    const port = u ? u.port : vmPort;
    const f = await ports.ensure(port);
    const target = u ? mapLocalUrl(u, f.localPort) : portUrl(f.localPort);
    if (open) void shell.openExternal(target);
    return { ok: true, vmPort: port, localPort: f.localPort, url: target };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** disconnect on purpose: first unmount our «Диск ПК» mounts through the still-open connection */
async function disconnectAll(): Promise<void> {
  if (conn.online) await pclink.shutdown();
  conn.disconnect();
}

conn.on('state', (s) => send('conn.state', s));
conn.on('offline', () => terminals.dropAll());
conn.on('agent-event', (event: string, data: unknown) => {
  if (cache.apply(event, data)) store.saveSnapshot(cache.toSnapshot());
  send('agent.event', { event, data });
});

function effectiveDark(): boolean {
  const t = store.settings.appearance.theme;
  return t === 'system' ? nativeTheme.shouldUseDarkColors : t === 'dark';
}

const transfers = new FileTransfers({
  transport: () => conn.transport,
  call: (method, params, timeoutMs) => conn.call(method, params, timeoutMs),
  askSavePath: async (suggested) => {
    const opts = { defaultPath: suggested, title: 'Сохранить на этом компьютере' };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    return r.canceled || !r.filePath ? null : r.filePath;
  },
  downloadsDir: () => app.getPath('downloads'),
  log,
});

/** the renderer's startup splash is up (window.ts: caption buttons match its background) */
let splashOn = true;

async function safeUpload(data: Uint8Array) {
  try {
    const r = await uploadImage(conn.transport, data);
    log('[image]', r.ok ? `uploaded ${data.length} B -> ${r.path}` : `refused: ${r.error}`);
    return r;
  } catch (e) {
    log('[image] upload failed:', (e as Error).message);
    return { ok: false as const, error: (e as Error).message };
  }
}

function applyTheme() {
  nativeTheme.themeSource = store.settings.appearance.theme;
  if (win) setOverlayTheme(win, effectiveDark(), splashOn);
  send('theme.dark', effectiveDark());
}

let manifestInfo = { agent: '?', hash: '?' };
try {
  const m = readBundledManifest(bundleDir);
  manifestInfo = { agent: m.agent, hash: m.hash };
} catch {
  log('[main] agent bundle missing: run npm run agent:manifest');
}

function trustedSender(e: Electron.IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? '';
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  return url.startsWith('file://') || (!!devUrl && url.startsWith(devUrl));
}

const handlers: Handlers = {
  'agent.call': async ({ method, params }) => {
    if (!METHODS.includes(method as Method) || MAIN_ONLY_METHODS.includes(method))
      return { ok: false, error: { code: 'bad_request', message: 'неизвестный метод' } };
    const parsed = methodSchemas[method as Method].safeParse(params ?? {});
    if (!parsed.success) return { ok: false, error: { code: 'bad_request', message: 'неверные параметры' } };
    try {
      const result = await conn.call(method, parsed.data, methodTimeout(method as Method));
      if (method === 'usage') {
        cache.usage = result as Usage;
        store.saveSnapshot(cache.toSnapshot());
      }
      return { ok: true, result: result as never };
    } catch (e) {
      const err =
        e instanceof RpcError ? e.toPayload() : { code: 'internal', message: String((e as Error).message) };
      return { ok: false, error: err };
    }
  },
  'conn.state': () => conn.state,
  'conn.retryNow': () => conn.retryNow(),
  'conn.disconnect': () => disconnectAll(),
  'conn.passphrase': ({ passphrase }) => conn.setPassphrase(passphrase),
  'conn.trustHost': ({ accept }) => conn.trustHost(accept),
  'conn.log': () => recentLog(),
  'conn.debugDrop': () => {
    if (debugTools) conn.debugDrop();
  },
  'conn.debugFreeze': () => {
    if (debugTools) conn.debugFreeze();
  },
  'conn.hosts': () => {
    const path = defaultConfigPath();
    const text = readConfig(path);
    const hosts = text ? listHosts(text) : [];
    const host = store.settings.connection.host;
    const r = text && hosts.includes(host) ? resolveHost(text, host, userInfo().username) : null;
    return {
      configPath: path,
      found: text != null,
      hosts,
      resolved: r
        ? {
            host: r.host,
            hostname: r.hostname,
            user: r.user,
            port: r.port,
            identityFile: r.identityFiles[0] ?? null,
          }
        : null,
    };
  },
  'settings.get': () => store.settings,
  'settings.set': (patch) => {
    const before = store.settings;
    const next = store.updateSettings(patch);
    if (before.appearance.theme !== next.appearance.theme) applyTheme();
    send('settings.changed', next);
    const c0 = before.connection;
    const c1 = next.connection;
    if (JSON.stringify(c0) !== JSON.stringify(c1)) {
      log('[main] connection settings changed: reconnect');
      void disconnectAll().then(() => conn.start());
    } else if (JSON.stringify(before.pcLink) !== JSON.stringify(next.pcLink)) void pclink.applySettings();
    if (before.askpass.enabled !== next.askpass.enabled) void askpass.applySettings();
    if (JSON.stringify(before.startup) !== JSON.stringify(next.startup)) applyAutostart();
    if (JSON.stringify(before.ports.pinned) !== JSON.stringify(next.ports.pinned)) {
      if (conn.online) void ports.restorePinned();
      send('ports.state', ports.list());
    }
    return next;
  },
  'workspace.get': () => store.workspace(),
  'workspace.save': (w) => store.saveWorkspace(w as Workspace),
  'snapshot.get': () => (cache.chats.size || cache.sessions.length ? cache.toSnapshot() : store.snapshot()),
  'term.open': async (a) => {
    try {
      await terminals.open(a);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  'term.write': ({ tabId, data, binary }) =>
    terminals.write(tabId, binary ? Buffer.from(data, 'latin1') : data),
  'term.resize': ({ tabId, cols, rows }) => terminals.resize(tabId, cols, rows),
  'term.close': ({ tabId }) => terminals.close(tabId),
  'term.ack': ({ tabId, bytes }) => terminals.ack(tabId, bytes),
  'clipboard.write': ({ text }) => clipboard.writeText(text),
  'diag.log': ({ text }) => log('[diag]', text),
  'sound.load': () => loadSound(store.settings.notifications.soundFile),
  'sound.pick': async () => {
    const opts = {
      title: 'Звук уведомления',
      properties: ['openFile' as const],
      filters: [{ name: 'Звук', extensions: ['wav', 'mp3', 'ogg'] }],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  },
  'notify.show': (a) => showSystemNotification(a),
  'clipboard.read': () => clipboard.readText(),
  'image.pasteClipboard': async () => {
    // Electron 45 clipboard API (W3C-like): the first image/* entry, e.g. a Win+Shift+S screenshot (image/png)
    for (const item of await clipboard.read()) {
      const type = item.types.find((x) => x.startsWith('image/'));
      if (!type) continue;
      const blob = (await item.getType(type)) as Blob;
      return safeUpload(new Uint8Array(await blob.arrayBuffer()));
    }
    return { ok: false as const, none: true as const };
  },
  'image.upload': ({ data }) => safeUpload(data),
  'file.download': ({ path }) => transfers.download(path),
  'file.upload': ({ dir, name, data, overwrite }) => transfers.upload(dir, name, data, overwrite),
  'file.reveal': ({ path }) => {
    if (transfers.canReveal(path)) shell.showItemInFolder(path);
  },
  'launch.rdp': () => launchRdp(store.settings.integrations.rdpScript, { log }),
  'launch.vscode': ({ path }) => {
    const s = store.settings;
    const host = s.integrations.remoteHost || s.connection.host;
    return launchVsCode(s.integrations.vscodeCommand, host, path);
  },
  'launch.openExternal': ({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  },
  'app.info': () => ({
    version: app.getVersion(),
    platform: process.platform,
    dev,
    agentVersion: manifestInfo.agent,
    agentHash: manifestInfo.hash,
    protocol: PROTOCOL,
    userData,
  }),
  'app.splash': ({ on }) => {
    splashOn = on;
    if (win) setOverlayTheme(win, effectiveDark(), on);
  },
  'app.toggleFullscreen': () => {
    if (win) win.setFullScreen(!win.isFullScreen());
  },
  'app.toggleDevTools': () => {
    if (win && debugTools) win.webContents.toggleDevTools();
  },
  'pclink.state': () => pclink.state,
  'pclink.mount': ({ dst }) => pclink.mount(dst),
  'pclink.unmount': ({ dst }) => pclink.unmount(dst),
  'pclink.reconnect': () => pclink.reconnectTunnel(),
  'ports.state': () => ports.list(),
  'ports.forward': ({ vmPort }) => forwardPort(vmPort),
  'ports.close': ({ vmPort }) => ports.close(vmPort),
  'ports.open': (a) => ('url' in a ? forwardPort(0, a.url, true) : forwardPort(a.vmPort, undefined, true)),
  'askpass.pending': () => [...askpass.pending.values()],
  'askpass.reply': ({ id, password }) => askpass.reply(id, password),
  'update.state': () => updater.state,
  'update.check': async () => {
    await updater.check();
    return updater.state;
  },
  'update.install': async () => ({ ok: await updater.installNow() }),
};

// keep references until closed: a garbage-collected Notification loses its click handler
const liveNotifications = new Set<Notification>();

function showSystemNotification(a: { title: string; body: string; session: string; chatId?: string }): {
  ok: boolean;
} {
  if (!Notification.isSupported()) {
    log('[notify] system notifications not supported');
    return { ok: false };
  }
  // silent: the renderer plays the user's own sound (settings), no double beep from Windows
  const n = new Notification({ title: a.title, body: a.body, silent: true });
  liveNotifications.add(n);
  const drop = () => liveNotifications.delete(n);
  n.on('click', () => {
    drop();
    showWindow(); // also from the tray-hidden state
    send('notify.click', { session: a.session, chatId: a.chatId });
  });
  n.on('close', drop);
  n.on('failed', (_e, err) => {
    drop();
    log('[notify] system notification failed', err);
  });
  n.show();
  return { ok: true };
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  store.patchWindow({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() });
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function hideWindow() {
  if (!win || win.isDestroyed()) return;
  saveBounds();
  win.hide();
}

/** start with Windows (packaged app only: in dev process.execPath is electron.exe, which would start a bare Electron) */
function applyAutostart() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  const s = store.settings.startup;
  try {
    app.setLoginItemSettings({ openAtLogin: s.autostart, args: s.startHidden ? ['--hidden'] : [] });
  } catch (e) {
    log('[main] autostart failed:', (e as Error).message);
  }
}

/** before any quit: unmount our «Диск ПК» mounts and close forwards while the connection is still there (bounded).
 * After it `before-quit` lets the quit through (also the updater's quitAndInstall) and close-to-tray is off. */
async function cleanupForQuit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  saveBounds();
  store.flush();
  updater.dispose();
  try {
    await disconnectAll();
    await ports.closeAll();
  } catch (e) {
    log('[main] cleanup on quit failed:', (e as Error).message);
  } finally {
    cleanedUp = true;
    tray?.destroy();
    tray = null;
  }
}

/** the one way out (tray «Выход», last window closed, external app.quit()) */
async function quitApp(): Promise<void> {
  if (quitting) return;
  await cleanupForQuit();
  app.quit();
}

// a second launch (shortcut, autostart while running) shows the existing window, also from the tray
app.on('second-instance', () => showWindow());

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  installCsp(dev);
  registerIpc(handlers, trustedSender);
  nativeTheme.themeSource = store.settings.appearance.theme;
  nativeTheme.on('updated', () => applyTheme());
  const ws = store.workspace();
  try {
    tray = new AppTray({
      connState: () => conn.state,
      pcState: () => pclink.state,
      windowVisible: () => !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized(),
      show: showWindow,
      hide: hideWindow,
      quit: () => void quitApp(),
    }).create();
  } catch (e) {
    log('[main] tray failed:', (e as Error).message);
    tray = null;
  }
  const hidden = startHidden && !!tray;
  win = createWindow({
    preload: join(__dirname, '../preload/index.js'),
    bounds: ws?.window ?? null,
    dev: debugTools,
    show: !hidden,
  });
  if (hidden) log('[main] started hidden in the tray');
  const trayUpdate = () => tray?.update();
  for (const ev of ['show', 'hide', 'minimize', 'restore'] as const) win.on(ev as 'show', trayUpdate);
  conn.on('state', trayUpdate);
  pclink.on('state', trayUpdate);
  applyAutostart();
  let boundsTimer: NodeJS.Timeout | null = null;
  const onBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveBounds, 500);
  };
  win.on('resize', onBounds);
  win.on('move', onBounds);
  win.on('close', (e) => {
    saveBounds();
    // close to tray: only hide; connection, PC tunnel, forwards and notifications keep running
    if (!quitting && tray && store.settings.tray.closeToTray) {
      e.preventDefault();
      win?.hide();
      if (!store.settings.hints.trayShown) {
        showSystemNotification({
          title: 'ClaudeSpace работает в трее',
          body: 'Связь с VM, туннель ПК и уведомления продолжают работать. Выйти: правой кнопкой по значку в трее → «Выход».',
          session: '',
        });
        send('settings.changed', store.updateSettings({ hints: { trayShown: true } }));
      }
    }
  });
  win.on('closed', () => (win = null));
  powerMonitor.on('resume', () => conn.retryNow());
  await rendererEntry(win);
  try {
    log(
      '[main] start',
      app.getVersion(),
      process.platform,
      'mode',
      store.settings.connection.mode,
      readFileSync(join(bundleDir, 'MANIFEST.json')).length > 0 ? 'bundle ok' : '',
    );
  } catch {
    log('[main] start without agent bundle');
  }
  conn.start();
  void updater.start();
});

app.on('window-all-closed', () => void quitApp());
// app.quit() from elsewhere (Windows logoff, Playwright): clean up first, then really quit
app.on('before-quit', (e) => {
  if (cleanedUp) return;
  e.preventDefault();
  void quitApp();
});
