// The phone UI in a browser (docs/MOBILE.md, step 4): `npm run mobile:dev` serves src/mobile with Vite, and this plugin
// runs main's core next to it, in the role the Android service will play: Connection with the local transport, the
// agent and tmux in a fake HOME on their own tmux socket, terminals, uploads. The page talks to it over Vite's
// websocket (src/shared/mobileWire.ts) through the same channels as the service (src/shared/mobile.ts).
// Dev only: nothing here ships in the desktop app or the APK.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utils } from 'ssh2';
import type { ParsedKey } from 'ssh2';
import type { Plugin, WebSocketClient } from 'vite';
import { termOpenSchema } from '../shared/ipc';
import type { ConnState } from '../shared/model';
import { defaultMobileSettings, mergeMobileSettings } from '../shared/mobile';
import type { MobileSettings, MobileSettingsPatch, PhoneKey } from '../shared/mobile';
import { WIRE, fromBase64, toBase64 } from '../shared/mobileWire';
import type { WireEvent, WireInvoke, WireResult, WireSimulate } from '../shared/mobileWire';
import { MAIN_ONLY_METHODS, METHODS, methodSchemas, methodTimeout } from '../shared/protocol';
import type { Method } from '../shared/protocol';
import { parseSettings } from '../shared/settings';
import { uploadAttachment } from './attach';
import { RpcError } from './agent/rpc';
import { Connection } from './connection';
import { fingerprint, forgetHostKey } from './ssh/hostkey';
import { TerminalManager } from './terminals';
import { LocalTransport } from './transport/local';

export interface DevCoreOptions {
  root: string;
  log?: (s: string) => void;
}

/** A fake HOME from the agent's test fixture, with a neutral prompt and tmux status (screenshots stay clean). */
function makeHome(root: string): string {
  const home = execFileSync(
    'python3',
    [
      '-c',
      'import sys; sys.path.insert(0, "agent"); from tests.fixtures import FakeHome; print(FakeHome().home)',
    ],
    { cwd: root, encoding: 'utf8' },
  ).trim();
  writeFileSync(join(home, '.tmux.conf'), `set -g status-right '"vm" %H:%M'\n`);
  writeFileSync(join(home, '.bashrc'), "PS1='vm:\\w$ '\n");
  writeFileSync(join(home, '.bash_profile'), '. ~/.bashrc\n');
  return home;
}

/**
 * Vite re-evaluates this module when it reloads the config (a restart), so state that must outlive one config load
 * (the live cores, the signal handler, the socket counter) is kept on globalThis.
 */
const shared = ((
  globalThis as { __csMobileDev?: { live: Set<DevCore>; wired: boolean; seq: number } }
).__csMobileDev ??= { live: new Set(), wired: false, seq: 0 });

export class DevCore {
  readonly home: string;
  readonly tmuxSocket: string;
  private readonly ud: string;
  private readonly ownHome: boolean;
  private readonly ownUd: boolean;
  private settings: MobileSettings;
  private simulated: ConnState | null = null;
  private readonly owners = new Map<string, WebSocketClient>();
  private readonly seen = new WeakSet<WebSocketClient>();
  readonly conn: Connection;
  readonly terms: TerminalManager;

  constructor(
    private readonly opts: DevCoreOptions,
    private readonly broadcast: (msg: WireEvent) => void,
  ) {
    const { root } = opts;
    this.ownHome = !process.env.CS_MOBILE_HOME;
    this.home = process.env.CS_MOBILE_HOME || makeHome(root);
    this.ownUd = !process.env.CLAUDESPACE_USER_DATA;
    this.ud = process.env.CLAUDESPACE_USER_DATA || mkdtempSync(join(tmpdir(), 'cs-mobile-ud-'));
    // one per core: after a restart the old core kills its tmux server, which must not be the new one's
    this.tmuxSocket = process.env.CS_MOBILE_TMUX || `claudespace-mobile-dev-${process.pid}-${++shared.seq}`;
    // children inherit this process's environment: no outer tmux or app id, and a host name fit for screenshots
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    delete process.env.CLAUDESPACE_APP;
    process.env.CSAGENT_HOSTNAME = 'vm';
    this.settings = this.loadSettings();
    const ptyHelper = join(root, 'resources', 'ptyhelper.py');
    const desktop = parseSettings({ connection: { mode: 'local', tmuxSocket: this.tmuxSocket } }, 'linux');
    this.conn = new Connection({
      settings: () => desktop,
      bundleDir: join(root, 'resources', 'agent'),
      ptyHelper,
      appKnownHosts: join(this.ud, 'known_hosts'),
      localFactory: () => new LocalTransport(ptyHelper, '/bin/bash', this.home),
      log: (...a) => opts.log?.(a.map(String).join(' ')),
    });
    this.conn.on('state', () => this.pushState());
    this.conn.on('agent-event', (event: string, data: unknown) =>
      this.broadcast({ event: 'agent.event', data: { event, data } }),
    );
    this.conn.on('offline', () => this.terms.dropAll());
    this.terms = new TerminalManager(
      {
        data: (tabId, data) =>
          this.toOwner(tabId, { event: 'term.data', data: { tabId, data64: toBase64(data) } }),
        exit: (tabId, code, signal) => {
          this.toOwner(tabId, { event: 'term.exit', data: { tabId, code, signal } });
          this.owners.delete(tabId);
        },
      },
      () => this.conn.transport,
      () => this.tmuxSocket,
      () => this.conn.appId,
    );
    if (this.configured()) this.conn.start();
  }

  private loadSettings(): MobileSettings {
    try {
      const raw = JSON.parse(
        readFileSync(join(this.ud, 'mobile-settings.json'), 'utf8'),
      ) as MobileSettingsPatch;
      return mergeMobileSettings(defaultMobileSettings(), raw);
    } catch {
      return defaultMobileSettings();
    }
  }

  private configured(): boolean {
    return !!this.settings.connection.host && !!this.settings.connection.user;
  }

  /** what the phone shows: like the service, nothing starts until a host and a user are set */
  state(): ConnState {
    if (this.simulated) return this.simulated;
    if (!this.configured())
      return { kind: 'needs-user', reason: 'config', detail: 'Укажите адрес VM и пользователя' };
    return this.conn.state;
  }

  private pushState() {
    this.broadcast({ event: 'conn.state', data: this.state() });
  }

  simulate(msg: WireSimulate) {
    this.simulated = msg.state;
    this.pushState();
  }

  private toOwner(tabId: string, msg: WireEvent) {
    this.owners.get(tabId)?.send(WIRE.event, msg);
  }

  private key(): PhoneKey {
    const f = join(this.ud, 'dev-key.pub');
    if (!existsSync(f)) {
      const k = utils.generateKeyPairSync('ed25519', { comment: 'ClaudeSpace phone (dev)' } as never);
      writeFileSync(f, k.public.trim() + '\n');
    }
    const line = readFileSync(f, 'utf8').trim();
    const parsed = utils.parseKey(line) as ParsedKey;
    return { publicKey: line, fingerprint: fingerprint(parsed.getPublicSSH()) };
  }

  /** a page went away (reload, closed tab): its terminals detach, the sessions stay */
  private watch(client: WebSocketClient) {
    if (this.seen.has(client)) return;
    this.seen.add(client);
    client.socket.on('close', () => {
      for (const [tabId, c] of this.owners)
        if (c === client) {
          this.terms.close(tabId);
          this.owners.delete(tabId);
        }
    });
  }

  async handle(msg: WireInvoke, client: WebSocketClient): Promise<WireResult> {
    this.watch(client);
    try {
      return { id: msg.id, ok: true, result: await this.run(msg.channel, msg.args, client) };
    } catch (e) {
      return { id: msg.id, ok: false, error: (e as Error).message || String(e) };
    }
  }

  private async run(channel: string, args: unknown, client: WebSocketClient): Promise<unknown> {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (channel) {
      case 'agent.call': {
        const method = a.method as Method;
        if (!METHODS.includes(method) || MAIN_ONLY_METHODS.includes(method))
          return { ok: false, error: { code: 'bad_request', message: 'неизвестный метод' } };
        const parsed = methodSchemas[method].safeParse(a.params ?? {});
        if (!parsed.success)
          return { ok: false, error: { code: 'bad_request', message: 'неверные параметры' } };
        try {
          return { ok: true, result: await this.conn.call(method, parsed.data, methodTimeout(method)) };
        } catch (e) {
          return {
            ok: false,
            error: e instanceof RpcError ? e.toPayload() : { code: 'internal', message: String(e) },
          };
        }
      }
      case 'conn.state':
        return this.state();
      case 'conn.retryNow':
        if (this.configured()) this.conn.retryNow();
        return undefined;
      case 'conn.trustHost':
        this.conn.trustHost(a.accept === true);
        return undefined;
      case 'conn.forgetHost':
        forgetHostKey(
          join(this.ud, 'known_hosts'),
          this.settings.connection.host,
          this.settings.connection.port,
        );
        return undefined;
      case 'settings.get':
        return this.settings;
      case 'settings.set': {
        const before = JSON.stringify(this.settings.connection);
        this.settings = mergeMobileSettings(this.settings, a as MobileSettingsPatch);
        writeFileSync(join(this.ud, 'mobile-settings.json'), JSON.stringify(this.settings, null, 1));
        this.broadcast({ event: 'settings.changed', data: this.settings });
        if (JSON.stringify(this.settings.connection) !== before) {
          this.terms.dropAll();
          this.conn.disconnect();
          if (this.configured()) this.conn.start();
          this.pushState();
        }
        return this.settings;
      }
      case 'key.get':
        return this.key();
      case 'term.open': {
        const p = termOpenSchema.safeParse(a);
        if (!p.success) return { ok: false, error: 'неверные параметры терминала' };
        try {
          this.owners.set(p.data.tabId, client);
          await this.terms.open(p.data);
          return { ok: true };
        } catch (e) {
          this.owners.delete(p.data.tabId);
          return { ok: false, error: (e as Error).message };
        }
      }
      case 'term.write':
        this.terms.write(String(a.tabId), a.binary ? Buffer.from(String(a.data), 'binary') : String(a.data));
        return undefined;
      case 'term.resize':
        this.terms.resize(String(a.tabId), Number(a.cols), Number(a.rows));
        return undefined;
      case 'term.close':
        this.terms.close(String(a.tabId));
        this.owners.delete(String(a.tabId));
        return undefined;
      case 'term.ack':
        this.terms.ack(String(a.tabId), Number(a.bytes));
        return undefined;
      case 'attach.upload':
        return uploadAttachment(this.conn.transport, String(a.name), fromBase64(String(a.data64)));
      default:
        throw new Error(`unknown channel ${channel}`);
    }
  }

  private closed = false;

  close() {
    if (this.closed) return;
    this.closed = true;
    this.terms.dropAll();
    this.conn.disconnect();
    spawnSync('tmux', ['-L', this.tmuxSocket, 'kill-server']);
    if (this.ownHome) rmSync(this.home, { recursive: true, force: true });
    if (this.ownUd) rmSync(this.ud, { recursive: true, force: true });
  }
}

/** Vite restarts the server (and so makes a new core) when the config changes: Ctrl+C must close every live one. */
function wireSignals() {
  if (shared.wired) return;
  shared.wired = true;
  for (const sig of ['SIGINT', 'SIGTERM'] as const)
    process.once(sig, () => {
      for (const c of shared.live) c.close();
      process.exit(0);
    });
}

export function mobileDevCore(opts: DevCoreOptions): Plugin {
  return {
    name: 'claudespace-mobile-dev-core',
    apply: 'serve',
    configureServer(server) {
      const core = new DevCore(opts, (msg) => server.ws.send(WIRE.event, msg));
      shared.live.add(core);
      wireSignals();
      server.ws.on(WIRE.invoke, (msg: WireInvoke, client: WebSocketClient) => {
        void core.handle(msg, client).then((r) => client.send(WIRE.result, r));
      });
      server.ws.on(WIRE.simulate, (msg: WireSimulate) => core.simulate(msg));
      server.httpServer?.once('close', () => {
        shared.live.delete(core);
        core.close();
      });
      opts.log?.(`[mobile-dev] fake HOME ${core.home}, tmux -L ${core.tmuxSocket}`);
    },
  };
}
