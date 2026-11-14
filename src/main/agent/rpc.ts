// JSON Lines RPC over an exec channel: requests with timeouts, responses matched by id, events.
import { EventEmitter } from 'node:events';
import type { AgentErrorPayload } from '../../shared/protocol';
import type { ExecChannel } from '../transport/types';

export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
  toPayload(): AgentErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.data !== undefined ? { data: this.data } : {}),
    };
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: RpcError) => void;
  timer: NodeJS.Timeout;
  method: string;
}

const MAX_LINE = 8 * 1024 * 1024;

export class AgentRpc extends EventEmitter {
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private readonly decoder = new TextDecoder('utf-8');

  constructor(private readonly ch: ExecChannel) {
    super();
    ch.on('data', (b: Buffer) => this.onData(b));
    ch.on('stderr', (b: Buffer) => this.emit('log', b.toString('utf8')));
    ch.on('close', (code: number | null) => this.onClose(code));
  }

  private onData(b: Buffer) {
    this.buf += this.decoder.decode(b, { stream: true });
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim()) this.onLine(line);
    }
    if (this.buf.length > MAX_LINE) {
      this.emit('log', 'rpc: oversized line dropped');
      this.buf = '';
    }
  }

  private onLine(line: string) {
    let msg: { id?: unknown; result?: unknown; error?: AgentErrorPayload; event?: string; data?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit('log', `rpc: bad JSON: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof msg.event === 'string') {
      this.emit('event', msg.event, msg.data);
      return;
    }
    const id = msg.id;
    if (typeof id !== 'number') {
      if (msg.error) this.emit('log', `rpc: error without id: ${msg.error.code} ${msg.error.message}`);
      return;
    }
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new RpcError(String(msg.error.code), String(msg.error.message), msg.error.data));
    else p.resolve(msg.result);
  }

  private onClose(code: number | null) {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcError('closed', 'соединение с агентом закрыто'));
    }
    this.pending.clear();
    this.emit('close', code);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  call<T = unknown>(method: string, params: unknown = {}, timeoutMs = 10_000): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError('closed', 'нет связи с агентом'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError('timeout', `агент не ответил за ${Math.round(timeoutMs / 1000)} с (${method})`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      this.ch.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  close(): void {
    this.ch.end();
    this.ch.close();
  }
}
