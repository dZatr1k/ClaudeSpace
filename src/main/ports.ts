// Port forwarding VM -> PC (BACKLOG 10): a local listener on THIS PC, 127.0.0.1 only (never 0.0.0.0), on the same
// port number if free, else the next free one; each connection becomes `forwardOut` over the one ssh2 connection to
// the VM's loopback. Listeners outlive reconnects (new connections use the current transport); pinned ports
// (settings.ports.pinned) are forwarded on every connect; everything is closed on quit.
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { VmPort } from '../shared/protocol';
import type { ForwardInfo } from '../shared/ports';
import { candidatePorts } from '../shared/ports';
import type { Settings } from '../shared/settings';
import type { Transport } from './transport/types';

interface Fwd {
  vmPort: number;
  localPort: number;
  server: Server | null;
  sockets: Set<Socket | Duplex>;
  conns: number;
}

export interface PortForwarderDeps {
  transport: () => Transport | null;
  settings: () => Settings;
  log?: (...a: unknown[]) => void;
}

/** listen on 127.0.0.1:port; resolves null if the port is taken / not allowed */
function tryListen(server: Server, port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const onErr = () => {
      server.removeListener('listening', onOk);
      resolve(null);
    };
    const onOk = () => {
      server.removeListener('error', onErr);
      const a = server.address();
      resolve(a && typeof a === 'object' ? a.port : null);
    };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen({ port, host: '127.0.0.1', exclusive: true });
  });
}

export class PortForwarder extends EventEmitter {
  private readonly fwd = new Map<number, Fwd>();
  private readonly pending = new Map<number, Promise<Fwd>>();
  /** latest list from the agent: where each VM port listens (127.0.0.1 / ::1 / any) */
  private vmPorts = new Map<number, VmPort>();
  private readonly log: (...a: unknown[]) => void;

  constructor(private readonly deps: PortForwarderDeps) {
    super();
    this.log = deps.log ?? (() => undefined);
  }

  setVmPorts(ports: VmPort[]): void {
    this.vmPorts = new Map((Array.isArray(ports) ? ports : []).map((p) => [p.port, p]));
  }

  list(): ForwardInfo[] {
    const pinned = new Set(this.deps.settings().ports.pinned);
    return [...this.fwd.values()]
      .map((f) => ({
        vmPort: f.vmPort,
        localPort: f.localPort,
        pinned: pinned.has(f.vmPort),
        conns: f.conns,
        direct: !f.server,
      }))
      .sort((a, b) => a.vmPort - b.vmPort);
  }

  private changed() {
    this.emit('state', this.list());
  }

  /** the VM's loopback address the port listens on: ::1 only if the process bound just that, else 127.0.0.1 */
  private dstAddr(vmPort: number): string {
    return this.vmPorts.get(vmPort)?.addr === '::1' ? '::1' : '127.0.0.1';
  }

  /** make sure vmPort is forwarded; returns the local port */
  async ensure(vmPort: number): Promise<ForwardInfo> {
    if (!Number.isInteger(vmPort) || vmPort < 1 || vmPort > 65535) throw new Error('неверный порт');
    const have = this.fwd.get(vmPort);
    if (have) return this.info(have);
    let p = this.pending.get(vmPort);
    if (!p) {
      p = this.open(vmPort).finally(() => this.pending.delete(vmPort));
      this.pending.set(vmPort, p);
    }
    return this.info(await p);
  }

  private info(f: Fwd): ForwardInfo {
    return this.list().find((x) => x.vmPort === f.vmPort) as ForwardInfo;
  }

  private async open(vmPort: number): Promise<Fwd> {
    const t = this.deps.transport();
    if (t && t.kind === 'local') {
      // dev on the VM itself: the port is already on this machine
      const f: Fwd = { vmPort, localPort: vmPort, server: null, sockets: new Set(), conns: 0 };
      this.fwd.set(vmPort, f);
      this.changed();
      return f;
    }
    if (!t?.forwardOut) throw new Error('нет связи с VM');
    const f: Fwd = { vmPort, localPort: 0, server: null, sockets: new Set(), conns: 0 };
    const server = createServer((sock) => this.onConnection(f, sock));
    server.on('error', (e) => this.log('[ports] listener error', vmPort, e.message));
    let port: number | null = null;
    for (const c of [...candidatePorts(vmPort), 0]) {
      port = await tryListen(server, c);
      if (port) break;
    }
    if (!port) throw new Error('не удалось занять порт на ПК');
    f.localPort = port;
    f.server = server;
    this.fwd.set(vmPort, f);
    this.log('[ports] forward', `127.0.0.1:${port}`, '->', `VM ${this.dstAddr(vmPort)}:${vmPort}`);
    this.changed();
    return f;
  }

  private onConnection(f: Fwd, sock: Socket) {
    sock.on('error', () => undefined);
    const t = this.deps.transport();
    if (!t?.forwardOut) {
      sock.destroy();
      return;
    }
    sock.pause();
    f.sockets.add(sock);
    f.conns++;
    this.changed();
    let ch: Duplex | null = null;
    const done = () => {
      if (!f.sockets.delete(sock)) return;
      if (ch) f.sockets.delete(ch);
      f.conns = Math.max(0, f.conns - 1);
      this.changed();
    };
    sock.on('close', () => {
      ch?.destroy();
      done();
    });
    t.forwardOut('127.0.0.1', sock.remotePort ?? 0, this.dstAddr(f.vmPort), f.vmPort).then(
      (c) => {
        ch = c;
        if (sock.destroyed) return c.destroy();
        f.sockets.add(c);
        c.on('error', () => sock.destroy());
        c.on('close', () => sock.destroy());
        sock.pipe(c);
        c.pipe(sock);
        sock.resume();
      },
      (e: Error) => {
        this.log('[ports] forwardOut failed', f.vmPort, e.message);
        sock.destroy();
      },
    );
  }

  async close(vmPort: number): Promise<void> {
    const f = this.fwd.get(vmPort);
    if (!f) return;
    this.fwd.delete(vmPort);
    for (const s of f.sockets) s.destroy();
    if (f.server) await new Promise<void>((r) => f.server?.close(() => r()));
    this.log('[ports] closed', vmPort);
    this.changed();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.fwd.keys()].map((p) => this.close(p)));
  }

  /** on (re)connect: forward the pinned ports (already open listeners just keep working) */
  async restorePinned(): Promise<void> {
    for (const p of this.deps.settings().ports.pinned) {
      try {
        await this.ensure(p);
      } catch (e) {
        this.log('[ports] pinned', p, (e as Error).message);
      }
    }
  }

  /** local mode has no listeners: drop the «direct» entries when the transport changes */
  resetDirect(): void {
    let any = false;
    for (const [k, f] of this.fwd)
      if (!f.server) {
        this.fwd.delete(k);
        any = true;
      }
    if (any) this.changed();
  }
}
