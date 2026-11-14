// Tray icon (stage 6): show/hide the window, connection and PC-tunnel status, quit. With "close to tray" the window
// only hides; the SSH connection, the PC tunnel, port forwards and notifications keep working.
import { Menu, nativeImage, Tray } from 'electron';
import type { NativeImage } from 'electron';
import type { ConnState } from '../shared/model';
import type { PcLinkState } from '../shared/pclink';

// 32x32 PNG diamonds (the ◆ of the title bar), shown at 16x16 logical size; generated, no binary resource files
const ICON_ONLINE =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAj0lEQVR42s2XyQ2AMAwE0yWlUEbqoxoQUh4gjlz2eh7+ZkZKYq/Tti4psmYPyKVCBE7wXiqrBa7wKQkr+LCEJXxIwhreLeEB75LwgjdLeMKbJLzhVQkF/FdCBf+UUMJfJdTwh0QE/CaBEQi/AsQjRHxDRCNCtGLEMEKMY0QgQUQyRChFxHLEYoJYzRDLqUkds3VgWdnfzt0AAAAASUVORK5CYII=';
const ICON_OFFLINE =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAjUlEQVR42s2XOQ6AMAwE836a0PJaEFIKEEcuez2F28xISex1WtYtRdbsAblUiMAJ3ktltcAVPiVhBR+WsIQPSVjDuyU84F0SXvBmCU94k4Q3vCqhgP9KqOCfEkr4q4Qa/pCIgN8kMALhV4B4hIhviGhEiFaMGEaIcYwIJIhIhgiliFiOWEwQqxliOTWpA54EkFl2mpC2AAAAAElFTkSuQmCC';

/** "VM: на связи (claude@vm)" etc. — the status line of the tray menu and tooltip */
export function connLine(s: ConnState): string {
  switch (s.kind) {
    case 'online':
      return `VM: на связи (${s.host})`;
    case 'connecting':
      return 'VM: подключение…';
    case 'offline':
      return 'VM: нет связи, переподключение…';
    case 'needs-user':
      return 'VM: требуется действие (откройте окно)';
    default:
      return 'VM: отключено';
  }
}

const TUNNEL: Record<PcLinkState['tunnel'], string> = {
  off: 'туннель выключен',
  local: 'локальный режим',
  waiting: 'нет связи с VM',
  starting: 'туннель…',
  ours: 'туннель ✓',
  foreign: 'внешний туннель',
  busy: 'порт 2222 занят',
  error: 'туннель ✕',
};

export function pcLine(s: PcLinkState): string {
  const parts = [TUNNEL[s.tunnel] ?? s.tunnel];
  if (s.sshd === 'down' && (s.tunnel === 'ours' || s.tunnel === 'foreign'))
    parts.push('sshd на ПК не отвечает');
  for (const m of s.mounts) parts.push(`диск ${m.label} ${m.mounted ? '✓' : '✕'}`);
  return `ПК: ${parts.join(' · ')}`;
}

export interface TrayDeps {
  connState: () => ConnState;
  pcState: () => PcLinkState;
  windowVisible: () => boolean;
  show: () => void;
  hide: () => void;
  quit: () => void;
}

export class AppTray {
  private tray: Tray | null = null;
  private readonly icons: { online: NativeImage; offline: NativeImage };
  private lastKey = '';

  constructor(private readonly deps: TrayDeps) {
    const img = (b64: string) => nativeImage.createFromBuffer(Buffer.from(b64, 'base64'), { scaleFactor: 2 });
    this.icons = { online: img(ICON_ONLINE), offline: img(ICON_OFFLINE) };
  }

  create(): this {
    this.tray = new Tray(this.icons.offline);
    this.tray.setToolTip('ClaudeSpace');
    // Windows: a click on the icon toggles the window; the menu is on the right click
    this.tray.on('click', () => (this.deps.windowVisible() ? this.deps.hide() : this.deps.show()));
    this.update();
    return this;
  }

  /** rebuild the menu (on connection / tunnel / window visibility changes); cheap no-op when nothing changed */
  update(): void {
    const t = this.tray;
    if (!t || t.isDestroyed()) return;
    const conn = this.deps.connState();
    const pc = this.deps.pcState();
    const visible = this.deps.windowVisible();
    const cl = connLine(conn);
    const pl = pc.tunnel === 'off' || pc.tunnel === 'local' ? null : pcLine(pc);
    const key = [cl, pl, visible].join('|');
    if (key === this.lastKey) return;
    this.lastKey = key;
    t.setImage(conn.kind === 'online' ? this.icons.online : this.icons.offline);
    t.setToolTip(['ClaudeSpace', cl, pl].filter(Boolean).join('\n'));
    t.setContextMenu(
      Menu.buildFromTemplate([
        visible
          ? { label: 'Скрыть окно', click: () => this.deps.hide() }
          : { label: 'Показать окно', click: () => this.deps.show() },
        { type: 'separator' },
        { label: cl, enabled: false },
        ...(pl ? [{ label: pl, enabled: false }] : []),
        { type: 'separator' },
        { label: 'Выход', click: () => this.deps.quit() },
      ]),
    );
  }

  destroy(): void {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }
}
