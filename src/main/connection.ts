// The single connection to the VM: config -> auth -> host key -> agent, keepalive/RTT, reconnect with backoff.
// Emits 'state' (ConnState), 'agent-event' (name, data), 'online' (transport), 'offline'.
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { ConnectConfig } from 'ssh2';
import type { ConnState, Hello } from '../shared/model';
import { PROTOCOL } from '../shared/protocol';
import type { Settings } from '../shared/settings';
import { AgentRpc, RpcError } from './agent/rpc';
import { agentCommand, ensureAgent, InstallError } from './agent/installer';
import { agentPath, probeAgent, probeKey } from './ssh/auth';
import { defaultIdentityFiles, expandHome, listHosts, readConfig, resolveHost } from './ssh/config';
import { checkHostKey, fingerprint, readKnownHosts, trustHostKey } from './ssh/hostkey';
import { LocalTransport } from './transport/local';
import { connectSsh, SshConnectError } from './transport/ssh';
import type { Transport } from './transport/types';

const SSH_NOISE =
  /CHANNEL_DATA|CHANNEL_EXTENDED_DATA|CHANNEL_WINDOW_ADJUST|keepalive@openssh\.com|REQUEST_SUCCESS|REQUEST_FAILURE|GLOBAL_REQUEST \(keepalive/;

export interface ConnectionDeps {
  settings: () => Settings;
  bundleDir: string;
  ptyHelper: string;
  appKnownHosts: string;
  sshDir?: string;
  platform?: string;
  env?: NodeJS.ProcessEnv;
  log?: (...a: unknown[]) => void;
  /** tests: replace the ssh2 connect */
  sshConnect?: (cfg: ConnectConfig) => Promise<Transport>;
  /** tests: replace the local transport */
  localFactory?: () => Transport;
  helloTimeoutMs?: number;
}

const BACKOFF = [1, 2, 4, 8, 16, 30];

export function backoffDelay(attempt: number, rand = Math.random): number {
  const base = BACKOFF[Math.min(attempt, BACKOFF.length - 1)] as number;
  return Math.round(base * 1000 * (0.8 + 0.4 * rand()));
}

class NeedsUser extends Error {
  constructor(readonly state: Extract<ConnState, { kind: 'needs-user' }>) {
    super(state.reason);
  }
}

export class Connection extends EventEmitter {
  state: ConnState = { kind: 'idle' };
  transport: Transport | null = null;
  rpc: AgentRpc | null = null;
  hello: Hello | null = null;
  /** this app on the VM for the current connection: the agent's --app and CLAUDESPACE_APP in our terminals, so that
   * with several apps (PC, phone) a sudo prompt or a link comes to the app whose terminal it came from */
  appId: string | null = null;
  private passphrase: string | null = null;
  private pendingHostKey: {
    host: string;
    port: number;
    blob: Buffer;
    result: 'unknown' | 'mismatch';
  } | null = null;
  private attempt = 0;
  private lostSince: number | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private rttTimer: NodeJS.Timeout | null = null;
  private running = false;
  private connecting = false;
  private generation = 0;
  private readonly log: (...a: unknown[]) => void;

  constructor(private readonly deps: ConnectionDeps) {
    super();
    this.log = deps.log ?? (() => undefined);
  }

  private setState(s: ConnState) {
    this.state = s;
    this.emit('state', s);
  }

  get online(): boolean {
    return this.state.kind === 'online' && !!this.rpc && !this.rpc.isClosed;
  }

  start(): void {
    this.running = true;
    void this.connect();
  }

  retryNow(): void {
    this.running = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.state.kind !== 'online') void this.connect();
  }

  disconnect(): void {
    this.running = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.teardown();
    this.setState({ kind: 'idle' });
  }

  setPassphrase(p: string): void {
    this.passphrase = p;
    this.retryNow();
  }

  trustHost(accept: boolean): void {
    const pk = this.pendingHostKey;
    if (accept && pk && pk.result === 'unknown') {
      trustHostKey(this.deps.appKnownHosts, pk.host, pk.port, pk.blob);
      this.log('[conn] trusted host key', pk.host, fingerprint(pk.blob));
    }
    this.pendingHostKey = null;
    if (accept) this.retryNow();
  }

  async call<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (!this.rpc || this.rpc.isClosed || this.state.kind !== 'online')
      throw new RpcError('offline', 'нет связи с VM');
    return this.rpc.call<T>(method, params, timeoutMs);
  }

  debugDrop(): void {
    this.log('[conn] debug: drop connection');
    this.transport?.debugDrop();
  }

  debugFreeze(): void {
    this.log('[conn] debug: freeze keepalive');
    this.transport?.debugFreeze();
  }

  private teardown() {
    this.generation++;
    if (this.rttTimer) clearInterval(this.rttTimer);
    this.rttTimer = null;
    const t = this.transport;
    const r = this.rpc;
    this.transport = null;
    this.rpc = null;
    this.hello = null;
    try {
      r?.close();
    } catch {
      /* ignore */
    }
    try {
      t?.close();
    } catch {
      /* ignore */
    }
  }

  private scheduleRetry(error: string) {
    if (!this.running) return;
    const delay = backoffDelay(this.attempt);
    this.attempt++;
    const since = this.lostSince ?? Date.now();
    this.lostSince = since;
    this.setState({ kind: 'offline', since, retryAt: Date.now() + delay, attempt: this.attempt, error });
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private onLost(why: string) {
    if (this.state.kind !== 'online') return;
    this.log('[conn] lost:', why);
    this.teardown();
    this.lostSince = Date.now();
    this.attempt = 0;
    this.emit('offline');
    this.scheduleRetry(why);
  }

  private async connect(): Promise<void> {
    if (this.connecting || !this.running) return;
    this.connecting = true;
    this.teardown();
    const gen = this.generation;
    try {
      const transport = await this.openTransport();
      if (gen !== this.generation || !this.running) {
        transport.close();
        return;
      }
      this.transport = transport;
      this.setState({ kind: 'connecting', step: 'agent', attempt: this.attempt });
      const { installed, kept } = await ensureAgent(transport, this.deps.bundleDir, (msg) =>
        this.setState({ kind: 'connecting', step: 'agent', attempt: this.attempt, detail: msg }),
      );
      if (installed) this.log('[conn] agent installed');
      if (kept) this.log(`[conn] the agent on the VM is from a newer release (${kept}), keeping it`);
      this.appId = randomBytes(8).toString('hex');
      const ch = await transport.exec(agentCommand(this.deps.settings().connection.tmuxSocket, this.appId));
      const rpc = new AgentRpc(ch);
      rpc.on('log', (s: string) => this.log('[agent]', s.trimEnd()));
      // events that arrive right after hello (initial snapshots) are held until we are online
      const early: [string, unknown][] = [];
      let live = false;
      const hello = await new Promise<Hello>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Агент не ответил за 10 с')),
          this.deps.helloTimeoutMs ?? 10_000,
        );
        rpc.on('event', (name: string, data: unknown) => {
          if (name === 'hello') {
            clearTimeout(timer);
            resolve(data as Hello);
          } else if (live) {
            if (this.rpc === rpc) this.emit('agent-event', name, data);
          } else early.push([name, data]);
        });
        rpc.once('close', () => {
          clearTimeout(timer);
          reject(new Error('агент завершился при запуске'));
        });
      });
      if (gen !== this.generation) {
        rpc.close();
        return;
      }
      if (hello.protocol !== PROTOCOL)
        throw new Error(`агент говорит на протоколе ${hello.protocol}, нужен ${PROTOCOL}`);
      this.rpc = rpc;
      this.hello = hello;
      transport.on('close', (e?: Error) => {
        if (gen === this.generation) this.onLost(e?.message || 'соединение закрыто');
      });
      rpc.on('close', () => {
        if (gen === this.generation) this.onLost('агент завершился');
      });
      this.attempt = 0;
      const was = this.lostSince;
      this.lostSince = null;
      this.setState({
        kind: 'online',
        since: Date.now(),
        rttMs: null,
        agent: hello.agent,
        host: `${hello.user}@${hello.host}`,
      });
      this.emit('agent-event', 'hello', hello);
      for (const [name, data] of early) this.emit('agent-event', name, data);
      live = true;
      this.emit('online', { transport, downMs: was ? Date.now() - was : 0 });
      this.startRtt(gen);
      this.log('[conn] online', hello.host, 'agent', hello.agent);
    } catch (e) {
      this.teardown();
      if (e instanceof NeedsUser) {
        this.log('[conn] needs user:', e.state.reason, e.state.detail ?? '');
        this.setState(e.state);
      } else if (e instanceof InstallError && e.reason !== 'upload' && e.reason !== 'verify') {
        this.log('[conn] install:', e.message);
        this.setState({ kind: 'needs-user', reason: 'agent-missing-deps', detail: e.message });
      } else {
        const msg = (e as Error).message || String(e);
        this.log('[conn] failed:', msg);
        this.scheduleRetry(msg);
      }
    } finally {
      this.connecting = false;
    }
  }

  private startRtt(gen: number) {
    const sec = this.deps.settings().connection.keepaliveSec;
    const ping = async () => {
      if (gen !== this.generation || !this.rpc) return;
      const t0 = Date.now();
      try {
        await this.rpc.call('ping', {}, sec * 1000 * 3);
        if (gen === this.generation && this.state.kind === 'online')
          this.setState({ ...this.state, rttMs: Date.now() - t0 });
      } catch (e) {
        if ((e as RpcError).code === 'timeout') {
          this.log('[conn] ping timeout');
          this.transport?.debugDrop();
          this.onLost('нет ответа (keepalive)');
        }
      }
    };
    void ping();
    this.rttTimer = setInterval(() => void ping(), sec * 1000);
  }

  private async openTransport(): Promise<Transport> {
    const s = this.deps.settings();
    this.setState({ kind: 'connecting', step: 'config', attempt: this.attempt });
    if (s.connection.mode === 'local') {
      return this.deps.localFactory ? this.deps.localFactory() : new LocalTransport(this.deps.ptyHelper);
    }
    const sshDir = this.deps.sshDir ?? join(homedir(), '.ssh');
    let target: { host: string; hostname: string; user: string; port: number; identityFiles: string[] };
    if (s.connection.manual) {
      const m = s.connection.manual;
      if (!m.hostname || !m.user)
        throw new NeedsUser({
          kind: 'needs-user',
          reason: 'config',
          detail: 'Укажите хост и пользователя в Настройках → Подключение',
        });
      target = {
        host: m.hostname,
        hostname: m.hostname,
        user: m.user,
        port: m.port,
        identityFiles: m.keyPath ? [expandHome(m.keyPath)] : defaultIdentityFiles(),
      };
    } else {
      const text = readConfig(join(sshDir, 'config'));
      if (text == null)
        throw new NeedsUser({
          kind: 'needs-user',
          reason: 'config',
          detail: `Нет файла ${join(sshDir, 'config')}`,
        });
      const r = resolveHost(text, s.connection.host, userInfo().username);
      if (!listHosts(text).includes(s.connection.host))
        throw new NeedsUser({
          kind: 'needs-user',
          reason: 'config',
          detail: `В ~/.ssh/config нет Host ${s.connection.host}`,
        });
      target = { ...r, identityFiles: r.identityFiles.length ? r.identityFiles : defaultIdentityFiles() };
    }

    this.setState({ kind: 'connecting', step: 'auth', attempt: this.attempt });
    const aPath = agentPath(this.deps.platform ?? process.platform, this.deps.env ?? process.env);
    const agent = await probeAgent(aPath);
    const key = probeKey(target.identityFiles, this.passphrase);
    const cfg: ConnectConfig = {
      host: target.hostname,
      port: target.port,
      username: target.user,
      keepaliveInterval: s.connection.keepaliveSec * 1000,
      keepaliveCountMax: 3,
      readyTimeout: 15000,
      debug: (m: string) => {
        // per-packet chatter (terminal traffic, window adjusts, keepalives) filled ~1 MB of log per half hour
        if (/passphrase|privateKey|password/i.test(m) || SSH_NOISE.test(m)) return;
        this.log('[ssh]', m);
      },
    };
    const keyFp = key.state === 'plain' || key.state === 'decrypted' ? key.fingerprint : '';
    if (agent.state === 'ok' && aPath) cfg.agent = aPath;
    if (key.state === 'plain') cfg.privateKey = key.data;
    if (key.state === 'decrypted') {
      cfg.privateKey = key.data;
      cfg.passphrase = key.passphrase;
    }
    if (!cfg.agent && !cfg.privateKey) {
      if (key.state === 'wrong-passphrase')
        throw new NeedsUser({ kind: 'needs-user', reason: 'passphrase', detail: 'Пароль не подошёл' });
      const keyNote =
        key.state === 'encrypted' ? key.path : key.state === 'none' ? '' : (key as { path?: string }).path;
      if (agent.state === 'down')
        throw new NeedsUser({ kind: 'needs-user', reason: 'agent-down', detail: keyNote ?? '' });
      throw new NeedsUser({ kind: 'needs-user', reason: 'agent-empty', detail: keyNote ?? '' });
    }

    this.pendingHostKey = null;
    const known = () => readKnownHosts([join(sshDir, 'known_hosts'), this.deps.appKnownHosts]);
    cfg.hostVerifier = (blob: Buffer) => {
      this.setState({ kind: 'connecting', step: 'hostkey', attempt: this.attempt });
      const res = checkHostKey(known(), target.hostname, target.port, blob);
      if (res === 'match') return true;
      this.pendingHostKey = { host: target.hostname, port: target.port, blob, result: res };
      return false;
    };
    try {
      const t = this.deps.sshConnect ? await this.deps.sshConnect(cfg) : await connectSsh(cfg);
      this.setState({ kind: 'connecting', step: 'auth', attempt: this.attempt });
      return t;
    } catch (e) {
      const pk = this.pendingHostKey as { host: string; port: number; blob: Buffer; result: string } | null;
      if (pk) {
        const fp = fingerprint(pk.blob);
        throw new NeedsUser({
          kind: 'needs-user',
          reason: pk.result === 'mismatch' ? 'hostkey-mismatch' : 'hostkey-new',
          fingerprint: fp,
          host: pk.port === 22 ? pk.host : `${pk.host}:${pk.port}`,
        });
      }
      if (e instanceof SshConnectError && e.kind === 'auth-rejected')
        throw new NeedsUser({
          kind: 'needs-user',
          reason: 'auth-rejected',
          detail: keyFp || 'ключ из ssh-agent',
        });
      throw new Error(`VM недоступна: ${(e as Error).message}`, { cause: e });
    }
  }
}
