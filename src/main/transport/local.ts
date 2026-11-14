// Local transport: commands run on this machine (dev on the VM without an SSH key, and tests).
// PTY channels use a tiny Python helper (resources/ptyhelper.py): no native node-pty build needed.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { Writable } from 'node:stream';
import type { ExecChannel, ExecOptions, Transport } from './types';

class LocalChannel extends EventEmitter implements ExecChannel {
  private closed = false;
  constructor(
    private readonly proc: ChildProcess,
    private readonly ctl: Writable | null,
  ) {
    super();
    proc.stdout?.on('data', (b: Buffer) => this.emit('data', b));
    proc.stderr?.on('data', (b: Buffer) => this.emit('stderr', b));
    proc.stdin?.on('error', () => undefined);
    ctl?.on('error', () => undefined);
    proc.on('error', (e) => {
      this.emit('stderr', Buffer.from(String(e)));
      this.finish(127, null);
    });
    proc.on('close', (code, signal) => this.finish(code, signal));
  }
  private finish(code: number | null, signal: NodeJS.Signals | null) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, signal);
  }
  write(data: Buffer | string): boolean {
    if (this.closed || !this.proc.stdin || this.proc.stdin.destroyed) return false;
    return this.proc.stdin.write(data);
  }
  end(): void {
    this.proc.stdin?.end();
  }
  close(): void {
    if (!this.closed) this.proc.kill('SIGHUP');
  }
  setWindow(rows: number, cols: number): void {
    this.ctl?.write(`${rows} ${cols}\n`);
  }
  pause(): void {
    this.proc.stdout?.pause();
  }
  resume(): void {
    this.proc.stdout?.resume();
  }
}

export class LocalTransport extends EventEmitter implements Transport {
  readonly kind = 'local' as const;
  private readonly procs = new Set<ChildProcess>();
  private closed = false;
  private frozen = false;

  constructor(
    private readonly ptyHelper: string,
    private readonly shell = '/bin/bash',
    private readonly home = homedir(),
  ) {
    super();
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecChannel> {
    if (this.closed) throw new Error('transport closed');
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: this.home };
    delete env.ELECTRON_RUN_AS_NODE;
    let proc: ChildProcess;
    if (opts.pty) {
      env.TERM = opts.pty.term ?? 'xterm-256color';
      delete env.TMUX;
      proc = spawn(
        'python3',
        ['-I', this.ptyHelper, String(opts.pty.rows), String(opts.pty.cols), this.shell, '-c', cmd],
        { cwd: this.home, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] },
      );
    } else {
      proc = spawn(this.shell, ['-c', cmd], { cwd: this.home, env, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    this.procs.add(proc);
    proc.on('close', () => this.procs.delete(proc));
    const ctl = opts.pty ? (proc.stdio[3] as Writable) : null;
    return new LocalChannel(proc, ctl);
  }

  async writeFile(path: string, data: Buffer, mode: number): Promise<void> {
    const p = isAbsolute(path) ? path : join(this.home, path);
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    await writeFile(p, data, { mode });
    await chmod(p, mode);
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    await copyFile(isAbsolute(remotePath) ? remotePath : join(this.home, remotePath), localPath);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.procs) p.kill('SIGHUP');
    this.emit('close');
  }

  debugDrop(): void {
    // like a dead socket: every channel dies, the transport reports the loss
    for (const p of this.procs) p.kill('SIGKILL');
    this.closed = true;
    this.emit('close', new Error('соединение оборвано (отладка)'));
  }

  debugFreeze(): void {
    // emulate keepalive timeout: stop reading, report the loss after the keepalive window
    if (this.frozen) return;
    this.frozen = true;
    for (const p of this.procs) p.stdout?.pause();
    setTimeout(() => this.debugDrop(), 3000);
  }
}
