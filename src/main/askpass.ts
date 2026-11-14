// sudo password prompts from the VM in the app (BACKLOG 11).
//
// The agent serves a unix socket for its askpass.py (SUDO_ASKPASS); it only answers while the app has enabled it
// (askpass_enable on every connect, following settings.askpass.enabled) — otherwise the script falls back to the
// GTK prompt on the VM desktop. A prompt arrives as the agent event askpass_request (forwarded to the renderer like
// every agent event, it carries no secret); here we only get the user's attention: bring the window to front (it may
// be hidden in the tray) and show a Windows notification if it was not focused. The renderer's answer comes back
// through IPC 'askpass.reply' -> reply() -> agent askpass_reply.
//
// The password: validated by zod in IPC, passed straight to the agent call, never logged (only id + ok/cancel), never
// kept. rpc.ts does not log requests; the agent does not log or echo it either (agent/tests/test_askpass.py).
import { EventEmitter } from 'node:events';
import type { AskpassRequest } from '../shared/askpass';
import type { Settings } from '../shared/settings';

export interface AskpassConn {
  on(event: 'online', cb: () => void): unknown;
  on(event: 'agent-event', cb: (name: string, data: unknown) => void): unknown;
  call<T>(method: string, params: unknown, timeoutMs: number): Promise<T>;
  readonly online: boolean;
}

export interface AskpassDeps {
  conn: AskpassConn;
  settings: () => Settings;
  log?: (...a: unknown[]) => void;
  /** a prompt arrived: get the user's attention (window to front, notification when unfocused) */
  attention?: (req: AskpassRequest) => void;
}

export class AskpassBroker extends EventEmitter {
  /** ids of prompts the agent is waiting on (no secrets) */
  readonly pending = new Map<string, AskpassRequest>();
  private readonly log: (...a: unknown[]) => void;

  constructor(private readonly deps: AskpassDeps) {
    super();
    this.log = deps.log ?? (() => undefined);
  }

  attach(): this {
    const c = this.deps.conn;
    c.on('online', () => {
      this.pending.clear();
      void this.applySettings();
    });
    c.on('agent-event', (name, data) => {
      if (name === 'askpass_request') {
        const req = data as AskpassRequest;
        this.pending.set(req.id, req);
        this.log('[askpass] request', req.id, 'session', req.session ?? '-');
        this.deps.attention?.(req);
      } else if (name === 'askpass_done') {
        const d = data as { id: string; reason: string };
        this.pending.delete(d.id);
        this.log('[askpass] done', d.id, d.reason);
      }
    });
    return this;
  }

  /** tell the agent whether to answer prompts (on connect and when the setting changes) */
  async applySettings(): Promise<void> {
    if (!this.deps.conn.online) return;
    const enabled = this.deps.settings().askpass.enabled;
    try {
      const r = await this.deps.conn.call<{ listening: boolean; socket: string }>(
        'askpass_enable',
        { enabled },
        10_000,
      );
      this.log('[askpass]', enabled ? 'enabled' : 'disabled', r.listening ? `listening ${r.socket}` : '');
    } catch (e) {
      this.log('[askpass] enable failed:', (e as Error).message);
    }
  }

  /** the user's answer; password null = cancel. Never log the password. */
  async reply(id: string, password: string | null): Promise<{ ok: boolean; error?: string }> {
    this.pending.delete(id);
    try {
      await this.deps.conn.call('askpass_reply', { id, password }, 10_000);
      this.log('[askpass] reply', id, password === null ? 'cancel' : 'ok');
      return { ok: true };
    } catch (e) {
      // agent errors never contain the password (it validates by hand and does not echo)
      const msg = (e as Error).message;
      this.log('[askpass] reply', id, 'failed:', msg);
      return { ok: false, error: msg };
    }
  }
}
