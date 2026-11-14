// ssh2 transport: one connection, many channels (agent exec, terminal PTYs, SFTP).
import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import type { Socket } from 'node:net';
import { Client } from 'ssh2';
import type { ClientChannel, ConnectConfig, SFTPWrapper, TcpConnectionDetails } from 'ssh2';
import type { Duplex } from 'node:stream';
import type { ExecChannel, ExecOptions, IncomingTcp, RemoteListener, Transport } from './types';

type ChannelEvent = 'data' | 'stderr' | 'close';
const CHANNEL_EVENTS: readonly ChannelEvent[] = ['data', 'stderr', 'close'];

/**
 * Callers get the channel via `await t.exec()` and subscribe a tick later; output that arrives in between
 * (common on a fast link: the first chunks come with CHANNEL_SUCCESS) must not be lost. Events are queued
 * per name until the first listener for that name is attached, then replayed in arrival order.
 */
export class SshChannel extends EventEmitter implements ExecChannel {
  private closed = false;
  private code: number | null = null;
  private signal: string | null = null;
  private readonly live = new Set<ChannelEvent>();
  private readonly pending: { ev: ChannelEvent; args: unknown[] }[] = [];
  private flushScheduled = false;

  constructor(private readonly ch: ClientChannel) {
    super();
    this.on('newListener', (ev: string | symbol) => {
      if (!CHANNEL_EVENTS.includes(ev as ChannelEvent) || this.live.has(ev as ChannelEvent)) return;
      this.live.add(ev as ChannelEvent);
      this.scheduleFlush(); // newListener fires before the listener is added
    });
    ch.on('data', (b: Buffer) => this.out('data', b));
    ch.stderr.on('data', (b: Buffer) => this.out('stderr', b));
    ch.on('exit', (code: number | null, signal?: string) => {
      this.code = typeof code === 'number' ? code : null;
      this.signal = signal ?? null;
    });
    ch.on('close', () => this.finish());
    ch.on('error', () => this.finish());
  }

  private out(ev: ChannelEvent, ...args: unknown[]) {
    // keep arrival order: while a deliverable event is still queued (flush pending), queue behind it
    const queuedLive = this.pending.some((p) => this.live.has(p.ev));
    if (this.live.has(ev) && !queuedLive) this.emit(ev, ...args);
    else this.pending.push({ ev, args });
  }

  private scheduleFlush() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      // deliver everything that now has a listener, in arrival order; events nobody listens to stay queued
      const keep: typeof this.pending = [];
      for (const p of this.pending.splice(0)) {
        if (this.live.has(p.ev)) this.emit(p.ev, ...p.args);
        else keep.push(p);
      }
      this.pending.push(...keep);
    });
  }

  private finish() {
    if (this.closed) return;
    this.closed = true;
    this.out('close', this.code, this.signal);
  }
  write(data: Buffer | string): boolean {
    if (this.closed) return false;
    return this.ch.write(data);
  }
  end(): void {
    if (!this.closed) this.ch.end();
  }
  close(): void {
    if (!this.closed) this.ch.close();
  }
  setWindow(rows: number, cols: number): void {
    if (!this.closed) this.ch.setWindow(rows, cols, 0, 0);
  }
  pause(): void {
    this.ch.pause();
  }
  resume(): void {
    this.ch.resume();
  }
}

export class SshTransport extends EventEmitter implements Transport {
  readonly kind = 'ssh' as const;
  private sftpP: Promise<SFTPWrapper> | null = null;
  private closed = false;
  /** 'addr:port' -> handler of incoming forwarded connections (forwardIn) */
  private readonly forwards = new Map<string, (c: IncomingTcp) => void>();

  constructor(private readonly client: Client) {
    super();
    client.on('close', () => this.onClose());
    client.on('error', (e) => this.onClose(e));
    client.on('tcp connection', (info: TcpConnectionDetails, accept, reject) => {
      const h = this.forwards.get(`${info.destIP}:${info.destPort}`);
      if (!h) return reject();
      h({ srcIP: info.srcIP, srcPort: info.srcPort, accept: () => accept() as Duplex, reject });
    });
  }

  forwardIn(bindAddr: string, port: number, onConnection: (c: IncomingTcp) => void): Promise<RemoteListener> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('нет соединения'));
      this.client.forwardIn(bindAddr, port, (err, bound) => {
        if (err) return reject(err);
        const real = bound || port;
        const key = `${bindAddr}:${real}`;
        this.forwards.set(key, onConnection);
        resolve({
          port: real,
          close: () =>
            new Promise<void>((res) => {
              this.forwards.delete(key);
              if (this.closed) return res();
              try {
                this.client.unforwardIn(bindAddr, real, () => res());
              } catch {
                res();
              }
            }),
        });
      });
    });
  }

  forwardOut(srcAddr: string, srcPort: number, dstAddr: string, dstPort: number): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('нет соединения'));
      this.client.forwardOut(srcAddr, srcPort, dstAddr, dstPort, (err, ch) =>
        err ? reject(err) : resolve(ch as Duplex),
      );
    });
  }

  private onClose(err?: Error) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', err);
  }

  exec(cmd: string, opts: ExecOptions = {}): Promise<ExecChannel> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('нет соединения'));
      const o = opts.pty
        ? { pty: { term: opts.pty.term ?? 'xterm-256color', cols: opts.pty.cols, rows: opts.pty.rows } }
        : {};
      this.client.exec(cmd, o, (err, ch) => (err ? reject(err) : resolve(new SshChannel(ch))));
    });
  }

  private sftp(): Promise<SFTPWrapper> {
    if (!this.sftpP) {
      this.sftpP = new Promise((resolve, reject) =>
        this.client.sftp((err, s) => (err ? reject(err) : resolve(s))),
      );
      this.sftpP.catch(() => (this.sftpP = null));
    }
    return this.sftpP;
  }

  async writeFile(path: string, data: Buffer, mode: number): Promise<void> {
    const s = await this.sftp();
    await new Promise<void>((resolve, reject) =>
      s.writeFile(path, data, { mode }, (e) => (e ? reject(e) : resolve())),
    );
    await new Promise<void>((resolve, reject) => s.chmod(path, mode, (e) => (e ? reject(e) : resolve())));
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    const s = await this.sftp();
    await new Promise<void>((resolve, reject) => {
      const src = s.createReadStream(remotePath);
      const dst = createWriteStream(localPath);
      src.on('error', (e: Error) => {
        dst.destroy();
        reject(e);
      });
      dst.on('error', reject);
      dst.on('finish', () => resolve());
      src.pipe(dst);
    });
  }

  close(): void {
    this.client.end();
  }

  private sock(): Socket | null {
    return ((this.client as unknown as { _sock?: Socket })._sock ?? null) as Socket | null;
  }

  debugDrop(): void {
    this.sock()?.destroy();
  }

  debugFreeze(): void {
    this.sock()?.pause();
  }
}

export type SshErrorKind = 'auth-rejected' | 'hostkey' | 'network' | 'timeout' | 'other';

export class SshConnectError extends Error {
  constructor(
    readonly kind: SshErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export function classifySshError(e: Error & { level?: string; code?: string }): SshErrorKind {
  if (e.level === 'client-authentication') return 'auth-rejected';
  if (e.level === 'client-timeout') return 'timeout';
  if (/host key|hostkey|verification failed/i.test(e.message)) return 'hostkey';
  if (
    e.code &&
    /^(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ECONNRESET|EAI_AGAIN|EPIPE)$/.test(e.code)
  )
    return 'network';
  if (e.level === 'client-socket') return 'network';
  return 'other';
}

export function connectSsh(cfg: ConnectConfig): Promise<SshTransport> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    let settled = false;
    c.once('ready', () => {
      settled = true;
      resolve(new SshTransport(c));
    });
    c.once('error', (e: Error & { level?: string; code?: string }) => {
      if (settled) return;
      settled = true;
      reject(new SshConnectError(classifySshError(e), e.message));
    });
    c.connect(cfg);
  });
}
