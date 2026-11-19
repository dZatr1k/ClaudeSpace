// Terminal channels: exec with a PTY on the current transport. tmux tabs attach to a session; temporary tabs run
// shell/lazygit/yazi/git clone directly. Output is batched (8 ms) and flow-controlled with renderer acks.
import type { TermOpenArgs } from '../shared/ipc';
import { SESSION_RE } from '../shared/protocol';
import { APP_ID_RE } from './agent/installer';
import type { ExecChannel, Transport } from './transport/types';
import { shq } from './transport/types';

export const BATCH_MS = 8;
export const HIGH_WATER = 1024 * 1024;
export const LOW_WATER = 256 * 1024;

const BASE_PREFIX =
  'export LANG="${LANG:-C.UTF-8}"; export PATH="$HOME/.local/bin:$PATH"; unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT;';

function homePath(p: string): string {
  // "~" and "~/x" -> "$HOME"-relative (quoted rest); absolute paths quoted as is
  if (p === '~') return '"$HOME"';
  if (p.startsWith('~/')) return `"$HOME"/${shq(p.slice(2))}`;
  return shq(p);
}

/**
 * Shell command for a terminal tab (runs through the user's shell on the VM). Throws on bad input. appId: this
 * connection's id, exported as CLAUDESPACE_APP so that the agent knows which app a tmux client or a shell belongs
 * to (agent/cclib/route.py).
 */
export function terminalCommand(
  a: TermOpenArgs,
  tmuxSocket: string | null = null,
  appId: string | null = null,
): string {
  const tmux = tmuxSocket ? `tmux -L ${shq(tmuxSocket)}` : 'tmux';
  const PREFIX = BASE_PREFIX + (appId && APP_ID_RE.test(appId) ? ` export CLAUDESPACE_APP=${appId};` : '');
  switch (a.kind) {
    case 'tmux': {
      if (!a.session || !SESSION_RE.test(a.session)) throw new Error('bad session name');
      return `${PREFIX} exec ${tmux} -u attach-session -t ${shq('=' + a.session)}`;
    }
    case 'shell':
      return `${PREFIX} cd ${homePath(a.cwd ?? '~')} && exec bash -l`;
    case 'lazygit':
      return `${PREFIX} cd ${homePath(a.cwd ?? '~')} && exec lazygit`;
    case 'yazi':
      return `${PREFIX} exec yazi ${homePath(a.cwd ?? '~')}`;
    case 'clone': {
      if (!a.url || !a.dest) throw new Error('url and dest required');
      if (!/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)[^\s]+$/.test(a.url)) throw new Error('bad repository url');
      return `${PREFIX} cd "$HOME" && git clone -- ${shq(a.url)} ${homePath(a.dest)}`;
    }
  }
}

interface Term {
  ch: ExecChannel;
  pending: Buffer[];
  pendingBytes: number;
  timer: NodeJS.Timeout | null;
  unacked: number;
  paused: boolean;
}

export interface TerminalSink {
  data(tabId: string, data: Uint8Array): void;
  exit(tabId: string, code: number | null, signal: string | null): void;
}

export class TerminalManager {
  private readonly terms = new Map<string, Term>();

  constructor(
    private readonly sink: TerminalSink,
    private readonly getTransport: () => Transport | null,
    private readonly tmuxSocket: () => string | null = () => null,
    private readonly appId: () => string | null = () => null,
  ) {}

  has(tabId: string): boolean {
    return this.terms.has(tabId);
  }

  async open(a: TermOpenArgs): Promise<void> {
    const t = this.getTransport();
    if (!t) throw new Error('нет связи с VM');
    this.close(a.tabId);
    const cmd = terminalCommand(a, this.tmuxSocket(), this.appId());
    const ch = await t.exec(cmd, { pty: { cols: a.cols, rows: a.rows, term: 'xterm-256color' } });
    const term: Term = { ch, pending: [], pendingBytes: 0, timer: null, unacked: 0, paused: false };
    this.terms.set(a.tabId, term);
    ch.on('data', (b: Buffer) => this.onData(a.tabId, term, b));
    ch.on('stderr', (b: Buffer) => this.onData(a.tabId, term, b));
    ch.on('close', (code: number | null, signal: string | null) => {
      this.flush(a.tabId, term);
      if (this.terms.get(a.tabId) === term) {
        this.terms.delete(a.tabId);
        this.sink.exit(a.tabId, code, signal);
      }
    });
  }

  private onData(tabId: string, term: Term, b: Buffer) {
    term.pending.push(b);
    term.pendingBytes += b.length;
    term.unacked += b.length;
    if (!term.paused && term.unacked > HIGH_WATER) {
      term.paused = true;
      term.ch.pause();
    }
    if (!term.timer) term.timer = setTimeout(() => this.flush(tabId, term), BATCH_MS);
  }

  private flush(tabId: string, term: Term) {
    if (term.timer) clearTimeout(term.timer);
    term.timer = null;
    if (!term.pendingBytes) return;
    const data = Buffer.concat(term.pending, term.pendingBytes);
    term.pending = [];
    term.pendingBytes = 0;
    this.sink.data(tabId, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }

  ack(tabId: string, bytes: number): void {
    const term = this.terms.get(tabId);
    if (!term) return;
    term.unacked = Math.max(0, term.unacked - bytes);
    if (term.paused && term.unacked < LOW_WATER) {
      term.paused = false;
      term.ch.resume();
    }
  }

  write(tabId: string, data: string | Buffer): void {
    this.terms.get(tabId)?.ch.write(data);
  }

  resize(tabId: string, cols: number, rows: number): void {
    this.terms.get(tabId)?.ch.setWindow(rows, cols);
  }

  close(tabId: string): void {
    const term = this.terms.get(tabId);
    if (!term) return;
    this.terms.delete(tabId);
    if (term.timer) clearTimeout(term.timer);
    term.ch.close();
  }

  /** connection lost: channels are gone; forget them silently (renderer shows the offline overlay) */
  dropAll(): void {
    for (const [, term] of this.terms) if (term.timer) clearTimeout(term.timer);
    this.terms.clear();
  }

  stats(tabId: string): { unacked: number; paused: boolean } | null {
    const t = this.terms.get(tabId);
    return t ? { unacked: t.unacked, paused: t.paused } : null;
  }
}
