// Swappable transport: ssh2 (production) or local processes (dev on the VM, tests). Everything above this
// layer (agent RPC, installer, terminals) only sees Transport/ExecChannel.
import type { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';

export interface PtyOptions {
  cols: number;
  rows: number;
  term?: string;
}

export interface ExecOptions {
  pty?: PtyOptions;
}

/** One exec channel: a remote command with stdin/stdout(/stderr), optionally on a PTY. */
export interface ExecChannel extends EventEmitter {
  write(data: Buffer | string): boolean;
  /** close stdin (EOF) */
  end(): void;
  /** terminate the channel (and the remote process) */
  close(): void;
  setWindow(rows: number, cols: number): void;
  pause(): void;
  resume(): void;
  // events: 'data' (Buffer), 'stderr' (Buffer), 'close' (code: number | null, signal: string | null)
}

export interface Transport extends EventEmitter {
  readonly kind: 'ssh' | 'local';
  /** run `cmd` through the user's shell on the target */
  exec(cmd: string, opts?: ExecOptions): Promise<ExecChannel>;
  /** write a file; relative paths are relative to the remote home */
  writeFile(path: string, data: Buffer, mode: number): Promise<void>;
  /** copy a remote file to a local path (streamed, any size) */
  download(remotePath: string, localPath: string): Promise<void>;
  close(): void;
  /**
   * Remote forwarding (ssh -R): the target listens on bindAddr:port; each incoming connection is handed to
   * onConnection (accept() returns the channel, reject() refuses it). Only the ssh transport has it.
   */
  forwardIn?(bindAddr: string, port: number, onConnection: (c: IncomingTcp) => void): Promise<RemoteListener>;
  /** Local forwarding (ssh -L): a stream to dstAddr:dstPort as seen from the target. */
  forwardOut?(srcAddr: string, srcPort: number, dstAddr: string, dstPort: number): Promise<Duplex>;
  /** dev: drop the connection abruptly (socket.destroy without closing channels) */
  debugDrop(): void;
  /** dev: stop reading the socket so that keepalive times out */
  debugFreeze(): void;
  // events: 'close' (error?: Error)
}

export interface IncomingTcp {
  srcIP: string;
  srcPort: number;
  accept(): Duplex;
  reject(): void;
}

export interface RemoteListener {
  port: number;
  /** stop listening on the target (existing connections stay) */
  close(): Promise<void>;
}

/** Run a command, collect stdout/stderr, resolve on close. */
export async function execCollect(
  t: Transport,
  cmd: string,
  timeoutMs = 15000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const ch = await t.exec(cmd);
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      ch.close();
      reject(new Error(`timeout: ${cmd.slice(0, 60)}`));
    }, timeoutMs);
    ch.on('data', (b: Buffer) => out.push(b));
    ch.on('stderr', (b: Buffer) => err.push(b));
    ch.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
    ch.end();
  });
}

/** POSIX single-quote for the remote shell. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
