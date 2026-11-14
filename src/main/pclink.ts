// PC <-> VM link (BACKLOG 12): the reverse tunnel VM 127.0.0.1:2222 -> this PC's 127.0.0.1:22 over the one ssh2
// connection (instead of a separate `ssh -R` kept by a script on the PC), and «Диск ПК»: winfs mounts through the agent.
//
// - The tunnel is requested on every (re)connect. If the port is already taken on the VM (an external
//   `ssh -R` started outside the app, or our own previous connection that sshd has not reaped yet), we do not fight: the state
//   is 'foreign'/'busy' and every RETRY_MS we look again (agent: /proc/net/tcp, no sshd log spam) and take it over
//   as soon as it is free — so `win`/`winfs` keep working when the external tunnel goes away.
// - Each tunnel connection is piped to net.connect(127.0.0.1:22). If this PC's sshd is not listening, the channel is
//   rejected at once (no hang for the VM side) and the state says sshd is down (logged once per change).
// - Mounts: mounted on connect (setting), ownership is decided by the agent (cclib/winfs.py). On disconnect/quit we
//   lazily unmount only our own mounts; if the app vanishes, the agent does it on EOF.
import { EventEmitter } from 'node:events';
import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Method, MethodResults, WinfsMount } from '../shared/protocol';
import { methodTimeout } from '../shared/protocol';
import type { PcLinkState, PcMountState, TunnelState } from '../shared/pclink';
import { initialPcLinkState, TUNNEL_PORT } from '../shared/pclink';
import type { Settings } from '../shared/settings';
import type { IncomingTcp, RemoteListener, Transport } from './transport/types';

export interface LinkConn {
  on(event: 'online', cb: (a: { transport: Transport }) => void): unknown;
  on(event: 'state', cb: (s: { kind: string }) => void): unknown;
  on(event: 'agent-event', cb: (name: string, data: unknown) => void): unknown;
  call<T>(method: string, params: unknown, timeoutMs: number): Promise<T>;
  readonly hello: { home: string } | null;
}

export interface PcLinkDeps {
  conn: LinkConn;
  settings: () => Settings;
  log?: (...a: unknown[]) => void;
  /** tests: where the PC's sshd is (default 127.0.0.1:22) */
  pcHost?: string;
  pcPort?: number;
  /** tests: port on the VM (default 2222) */
  tunnelPort?: number;
  retryMs?: number;
}

const RETRY_MS = 15_000;

export function expandDst(dst: string, home: string | null | undefined): string {
  if (!home) return dst;
  if (dst === '~') return home;
  return dst.startsWith('~/') ? home + dst.slice(1) : dst.replace(/\/+$/, '');
}

export function mountLabel(dst: string): string {
  const parts = dst.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || dst;
}

function errText(e: unknown): string {
  return (e as Error)?.message || String(e);
}

export class PcLink extends EventEmitter {
  state: PcLinkState = { ...initialPcLinkState };
  private transport: Transport | null = null;
  private listener: RemoteListener | null = null;
  private gen = 0;
  private timer: NodeJS.Timeout | null = null;
  private trying = false;
  private readonly sockets = new Set<Socket>();
  private readonly channels = new Set<Duplex>();
  /** agent's view of sshfs mounts in $HOME */
  private actual: WinfsMount[] = [];
  /** dst (absolute) of mounts this app mounted in this run: re-claimed after a reconnect even without autoMount */
  private readonly appMounted = new Set<string>();
  private readonly busy = new Map<string, 'mount' | 'unmount'>();
  private readonly errors = new Map<string, string>();
  private readonly log: (...a: unknown[]) => void;
  private readonly port: number;

  constructor(private readonly deps: PcLinkDeps) {
    super();
    this.log = deps.log ?? (() => undefined);
    this.port = deps.tunnelPort ?? TUNNEL_PORT;
  }

  /** subscribe to the connection */
  attach(): this {
    const c = this.deps.conn;
    c.on('online', ({ transport }) => void this.onOnline(transport));
    c.on('state', (s) => {
      if (s.kind !== 'online' && this.transport) this.onOffline();
    });
    c.on('agent-event', (name, data) => {
      if (name === 'winfs_changed') this.setActual((data as { mounts: WinfsMount[] }).mounts);
    });
    this.refreshMounts();
    return this;
  }

  private get home(): string | null {
    return this.deps.conn.hello?.home ?? null;
  }

  private call<M extends Method>(method: M, params: unknown): Promise<MethodResults[M]> {
    return this.deps.conn.call<MethodResults[M]>(method, params, methodTimeout(method));
  }

  private set(p: Partial<PcLinkState>) {
    this.state = { ...this.state, ...p };
    this.emit('state', this.state);
  }

  private setTunnel(tunnel: TunnelState, detail: string | null = null, nextTryAt: number | null = null) {
    if (tunnel !== this.state.tunnel || detail !== this.state.detail)
      this.log('[pclink] tunnel', tunnel, detail ?? '');
    this.set({ tunnel, detail, nextTryAt });
  }

  private setSshd(v: 'ok' | 'down', why?: string) {
    if (this.state.sshd === v) return;
    this.log('[pclink] PC sshd', v, why ?? '');
    const wasDown = this.state.sshd === 'down';
    this.set({ sshd: v });
    if (v === 'ok' && wasDown && this.usable) void this.autoMount(this.gen);
  }

  private setActual(m: WinfsMount[]) {
    this.actual = Array.isArray(m) ? m : [];
    this.refreshMounts();
  }

  private refreshMounts() {
    const home = this.home;
    const mounts: PcMountState[] = this.deps.settings().pcLink.mounts.map(({ src, dst }) => {
      const abs = expandDst(dst, home);
      const a = this.actual.find((x) => x.dst === abs);
      return {
        src,
        dst,
        label: mountLabel(dst),
        mounted: !!a,
        owned: !!a?.owned,
        busy: this.busy.get(abs) ?? null,
        error: this.errors.get(abs) ?? null,
      };
    });
    this.set({ mounts });
  }

  get usable(): boolean {
    return this.state.tunnel === 'ours' || this.state.tunnel === 'foreign';
  }

  // ---------------------------------------------------------------- connection lifecycle
  private async onOnline(transport: Transport) {
    this.onOffline(true);
    const gen = ++this.gen;
    this.transport = transport;
    try {
      const st = await this.call('winfs_status', {});
      if (gen === this.gen) this.setActual(st.mounts);
    } catch (e) {
      this.log('[pclink] winfs_status failed:', errText(e));
    }
    if (gen !== this.gen) return;
    await this.startTunnel(gen);
  }

  private onOffline(quiet = false) {
    this.gen++;
    this.clearTimer();
    this.transport = null;
    this.listener = null; // the connection is gone: sshd drops the forward by itself
    this.dropSockets();
    if (!quiet) this.setTunnel('waiting');
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private dropSockets() {
    for (const s of this.sockets) s.destroy();
    for (const c of this.channels) c.destroy();
    this.sockets.clear();
    this.channels.clear();
    if (this.state.conns) this.set({ conns: 0 });
  }

  private schedule(gen: number) {
    this.clearTimer();
    const ms = this.deps.retryMs ?? RETRY_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (gen === this.gen) void this.tick(gen);
    }, ms);
    return Date.now() + ms;
  }

  private async tick(gen: number) {
    if (this.state.tunnel === 'ours') {
      await this.probeSshd();
      if (gen === this.gen) this.schedule(gen);
    } else await this.startTunnel(gen);
  }

  private tunnelWanted(t: Transport): TunnelState | null {
    if (t.kind !== 'ssh' || !t.forwardIn) return 'local';
    if (!this.deps.settings().pcLink.tunnel) return 'off';
    return null;
  }

  private async startTunnel(gen: number) {
    const t = this.transport;
    if (!t || gen !== this.gen || this.trying) return;
    const no = this.tunnelWanted(t);
    const forwardIn = t.forwardIn?.bind(t);
    if (no) {
      this.setTunnel(no);
      // without our tunnel an external one may still be there: check once, so manual mount works and says so
      if (no === 'off') await this.checkForeign(gen, false);
      return;
    }
    if (this.listener || !forwardIn) return;
    this.trying = true;
    const wasUsable = this.usable;
    try {
      if (this.state.tunnel !== 'foreign' && this.state.tunnel !== 'busy') this.setTunnel('starting');
      // look first: binding a taken port only fills the VM's auth.log with "Address already in use"
      if (await this.checkForeign(gen, true)) return;
      if (gen !== this.gen) return;
      try {
        const l = await forwardIn('127.0.0.1', this.port, (c) => this.onIncoming(c));
        if (gen !== this.gen) {
          void l.close();
          return;
        }
        this.listener = l;
        this.setTunnel('ours', null, this.schedule(gen));
        await this.probeSshd();
      } catch (e) {
        if (gen !== this.gen) return;
        // raced with another holder, or sshd refused remote forwarding (AllowTcpForwarding)
        if (await this.checkForeign(gen, true)) return;
        this.setTunnel('error', `VM не дала порт ${this.port}: ${errText(e)}`, this.schedule(gen));
      }
    } finally {
      this.trying = false;
    }
    if (gen === this.gen && this.usable && !wasUsable) await this.autoMount(gen);
  }

  /** port taken by someone else? sets foreign/busy and schedules a retry; returns true if taken */
  private async checkForeign(gen: number, retry: boolean): Promise<boolean> {
    let st: MethodResults['pc_tunnel_status'];
    try {
      st = await this.call('pc_tunnel_status', { port: this.port, banner: true });
    } catch (e) {
      this.log('[pclink] pc_tunnel_status failed:', errText(e));
      return false;
    }
    if (gen !== this.gen || !st.listening) return false;
    const wasUsable = this.usable;
    const next = retry ? this.schedule(gen) : null;
    if (st.banner) {
      if (retry) this.setTunnel('foreign', 'порт 2222 держит внешний туннель (не приложения)', next);
      else this.set({ detail: 'есть внешний туннель' });
      if (retry && !wasUsable) void this.autoMount(gen);
    } else if (retry) this.setTunnel('busy', 'порт 2222 занят и не отвечает (зависшее соединение)', next);
    return true;
  }

  private onIncoming(c: IncomingTcp) {
    const sock = netConnect({ host: this.deps.pcHost ?? '127.0.0.1', port: this.deps.pcPort ?? 22 });
    sock.setNoDelay(true);
    this.sockets.add(sock);
    let ch: Duplex | null = null;
    const done = () => {
      this.sockets.delete(sock);
      if (ch) this.channels.delete(ch);
      this.set({ conns: this.channels.size });
    };
    sock.once('connect', () => {
      this.setSshd('ok');
      try {
        ch = c.accept();
      } catch {
        sock.destroy();
        return;
      }
      this.channels.add(ch);
      this.set({ conns: this.channels.size });
      ch.on('error', () => sock.destroy());
      ch.on('close', () => {
        sock.destroy();
        done();
      });
      sock.on('close', () => {
        ch?.end();
        done();
      });
      sock.pipe(ch);
      ch.pipe(sock);
    });
    sock.on('error', (e: NodeJS.ErrnoException) => {
      if (!ch) {
        try {
          c.reject();
        } catch {
          /* gone */
        }
        this.setSshd('down', e.code);
        done();
      } else ch.destroy();
    });
  }

  private probeSshd(): Promise<void> {
    return new Promise((resolve) => {
      const s = netConnect({ host: this.deps.pcHost ?? '127.0.0.1', port: this.deps.pcPort ?? 22 });
      const fin = (ok: boolean, why?: string) => {
        clearTimeout(timer);
        s.destroy();
        this.setSshd(ok ? 'ok' : 'down', why);
        resolve();
      };
      const timer = setTimeout(() => fin(false, 'timeout'), 3000);
      s.once('connect', () => fin(true));
      s.once('error', (e: NodeJS.ErrnoException) => fin(false, e.code));
    });
  }

  // ---------------------------------------------------------------- mounts
  private async autoMount(gen: number) {
    const s = this.deps.settings().pcLink;
    const home = this.home;
    if (this.state.sshd === 'down') return;
    for (const m of s.mounts) {
      const abs = expandDst(m.dst, home);
      if (!s.autoMount && !this.appMounted.has(abs)) continue;
      if (gen !== this.gen) return;
      const a = this.actual.find((x) => x.dst === abs);
      if (a && !a.owned && !this.appMounted.has(abs)) continue; // mounted by hand: leave it alone
      await this.mount(m.dst, true);
    }
  }

  async mount(dst: string, auto = false): Promise<{ ok: boolean; error?: string }> {
    const m = this.deps.settings().pcLink.mounts.find((x) => x.dst === dst);
    if (!m) return { ok: false, error: 'нет такого диска в настройках' };
    const abs = expandDst(dst, this.home);
    if (this.busy.has(abs)) return { ok: false, error: 'уже выполняется' };
    this.busy.set(abs, 'mount');
    this.errors.delete(abs);
    this.refreshMounts();
    try {
      const r = await this.call('winfs_mount', { src: m.src, dst: m.dst });
      if (r.owned) this.appMounted.add(r.dst);
      this.log(
        '[pclink] mount',
        m.src,
        '->',
        r.dst,
        r.already ? '(already)' : '',
        r.owned ? 'ours' : 'manual',
      );
      return { ok: true };
    } catch (e) {
      const msg = errText(e);
      this.errors.set(abs, msg);
      this.log('[pclink] mount failed', auto ? '(auto)' : '', m.dst, msg);
      return { ok: false, error: msg };
    } finally {
      this.busy.delete(abs);
      this.refreshMounts();
    }
  }

  async unmount(dst: string): Promise<{ ok: boolean; error?: string }> {
    const abs = expandDst(dst, this.home);
    if (this.busy.has(abs)) return { ok: false, error: 'уже выполняется' };
    this.busy.set(abs, 'unmount');
    this.errors.delete(abs);
    this.refreshMounts();
    try {
      // explicit user action: may unmount a manual mount too (the menu says which one it is)
      await this.call('winfs_unmount', { dst, onlyOwned: false });
      this.appMounted.delete(abs);
      this.log('[pclink] unmount', dst);
      return { ok: true };
    } catch (e) {
      const msg = errText(e);
      this.errors.set(abs, msg);
      return { ok: false, error: msg };
    } finally {
      this.busy.delete(abs);
      this.refreshMounts();
    }
  }

  async reconnectTunnel(): Promise<void> {
    const gen = this.gen;
    const l = this.listener;
    this.listener = null;
    this.dropSockets();
    this.clearTimer();
    if (l) await l.close().catch(() => undefined);
    if (gen === this.gen) await this.startTunnel(gen);
  }

  /** settings changed (tunnel on/off, mounts list) */
  async applySettings(): Promise<void> {
    this.refreshMounts();
    const t = this.transport;
    if (!t) return;
    if (!this.deps.settings().pcLink.tunnel && this.listener) {
      const l = this.listener;
      this.listener = null;
      this.dropSockets();
      this.clearTimer();
      await l.close().catch(() => undefined);
    }
    if (!this.listener) {
      this.clearTimer();
      await this.startTunnel(this.gen);
    }
  }

  /** before disconnect/quit: unmount our own mounts (lazy: never blocks on a busy or dead mount), drop the forward */
  async shutdown(timeoutMs = 5000): Promise<void> {
    this.clearTimer();
    const work = (async () => {
      for (const m of this.actual.filter((x) => x.owned)) {
        try {
          await this.call('winfs_unmount', { dst: m.dst, onlyOwned: true, lazy: true });
          this.log('[pclink] unmounted on exit', m.dst);
        } catch (e) {
          this.log('[pclink] unmount on exit failed', m.dst, errText(e));
        }
      }
      const l = this.listener;
      this.listener = null;
      if (l) await l.close().catch(() => undefined);
    })();
    await Promise.race([work, new Promise((r) => setTimeout(r, timeoutMs))]);
    this.dropSockets();
  }
}
