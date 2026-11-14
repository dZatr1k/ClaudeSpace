// End-to-end over real SSH (in-process ssh2 Server on 127.0.0.1, generated keys, fake HOME, test tmux socket):
// host key TOFU / mismatch, auth, passphrase, agent install over SFTP, agent RPC, terminal PTY, flow control,
// connection drop + reconnect. Nothing touches ~/.ssh or the user's tmux.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnState } from '../../src/shared/model';
import { parseSettings } from '../../src/shared/settings';
import type { Settings } from '../../src/shared/settings';
import { Connection } from '../../src/main/connection';
import { TerminalManager, HIGH_WATER } from '../../src/main/terminals';
import {
  BUNDLE,
  PTY_HELPER,
  TMUX_SOCKET,
  ensureBundle,
  killTmux,
  makeFakeHome,
  tmux,
  waitFor,
} from './helpers';
import type { FakeHome } from './helpers';
import { genKey, startServer } from './sshServer';
import type { TestServer } from './sshServer';

let fh: FakeHome;
let dir: string;
let server: TestServer;
const key = genKey();

function settingsFor(port: number, keyPath: string): Settings {
  const s = parseSettings({}, 'win32');
  s.connection.mode = 'ssh';
  s.connection.manual = { hostname: '127.0.0.1', port, user: 'tester', keyPath };
  s.connection.tmuxSocket = TMUX_SOCKET;
  s.connection.keepaliveSec = 15;
  return s;
}

function makeConn(settings: Settings) {
  const states: ConnState[] = [];
  const events: [string, unknown][] = [];
  const conn = new Connection({
    settings: () => settings,
    bundleDir: BUNDLE,
    ptyHelper: PTY_HELPER,
    appKnownHosts: join(dir, 'known_hosts'),
    sshDir: join(dir, 'ssh'),
    platform: 'linux',
    env: {},
    log: process.env.CS_DEBUG ? (...a: unknown[]) => console.error(...a) : undefined,
  });
  conn.on('state', (s: ConnState) => states.push(s));
  conn.on('agent-event', (n: string, d: unknown) => events.push([n, d]));
  return { conn, states, events };
}

beforeAll(async () => {
  ensureBundle();
  killTmux();
  fh = makeFakeHome();
  dir = mkdtempSync(join(tmpdir(), 'cs-ssh-'));
  writeFileSync(join(dir, 'id_test'), key.private, { mode: 0o600 });
  server = await startServer({ home: fh.home, allowedPublic: key.public });
});

afterAll(async () => {
  await server?.close();
  killTmux();
  fh?.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe('ssh connection', () => {
  it('asks to trust a new host key, then installs the agent over SFTP and goes online', async () => {
    const { conn, states, events } = makeConn(settingsFor(server.port, join(dir, 'id_test')));
    conn.start();
    const hk = await waitFor(() => states.find((s) => s.kind === 'needs-user'), 15000, 'needs-user');
    expect(hk).toMatchObject({ kind: 'needs-user', reason: 'hostkey-new' });
    expect((hk as { fingerprint: string }).fingerprint).toMatch(/^SHA256:/);
    conn.trustHost(true);
    await waitFor(() => conn.state.kind === 'online', 20000, 'online');
    // installed into the fake HOME with the bundled manifest
    const installed = JSON.parse(readFileSync(join(fh.home, '.local/lib/claudespace/MANIFEST.json'), 'utf8'));
    const bundled = JSON.parse(readFileSync(join(BUNDLE, 'MANIFEST.json'), 'utf8'));
    expect(installed.hash).toBe(bundled.hash);
    expect(readFileSync(join(dir, 'known_hosts'), 'utf8')).toMatch(/^\[127\.0\.0\.1\]:\d+ ssh-ed25519 /);
    // initial snapshots arrive as events
    await waitFor(
      () => events.find(([n, d]) => n === 'chats_changed' && (d as { full?: unknown[] }).full),
      10000,
      'chats',
    );
    await waitFor(() => events.find(([n]) => n === 'projects_changed'), 10000, 'projects');
    const r = await conn.call<{ chats: { id: string }[] }>('list_chats', {}, 10000);
    expect(r.chats.length).toBeGreaterThan(3);
    conn.disconnect();
  });

  it('reuses the trusted key and the installed agent (no reinstall when the hash matches)', async () => {
    const before = server.execs.length;
    const { conn } = makeConn(settingsFor(server.port, join(dir, 'id_test')));
    conn.start();
    await waitFor(() => conn.state.kind === 'online', 20000, 'online');
    const execs = server.execs.slice(before);
    expect(execs.some((c) => c.includes('claudespace.tmp-'))).toBe(false);
    conn.disconnect();
  });

  it('reinstalls when an installed file was changed', async () => {
    const f = join(fh.home, '.local/lib/claudespace/MANIFEST.json');
    const m = JSON.parse(readFileSync(f, 'utf8'));
    m.hash = 'sha256:changed';
    writeFileSync(f, JSON.stringify(m));
    const { conn } = makeConn(settingsFor(server.port, join(dir, 'id_test')));
    conn.start();
    await waitFor(() => conn.state.kind === 'online', 20000, 'online');
    expect(JSON.parse(readFileSync(f, 'utf8')).hash).not.toBe('sha256:changed');
    conn.disconnect();
  });

  it('terminal: attach to a tmux session over an SSH PTY, resize, flow control', async () => {
    const { conn } = makeConn(settingsFor(server.port, join(dir, 'id_test')));
    conn.start();
    await waitFor(() => conn.state.kind === 'online', 20000, 'online');
    const ns = await conn.call<{ session: string }>('new_session', { cwd: fh.alpha }, 10000);
    expect(ns.session).toMatch(/^Alpha/);
    const out = new Map<string, Buffer[]>();
    const exits: string[] = [];
    const tm = new TerminalManager(
      {
        data: (id, d) => out.set(id, [...(out.get(id) ?? []), Buffer.from(d)]),
        exit: (id) => exits.push(id),
      },
      () => conn.transport,
      () => TMUX_SOCKET,
    );
    const text = (id: string) => Buffer.concat(out.get(id) ?? []).toString('utf8');
    await tm.open({ tabId: 't1', kind: 'tmux', session: ns.session, cols: 100, rows: 30 });
    await waitFor(() => text('t1').includes('fake claude'), 10000, 'claude output');
    for (const b of out.get('t1') ?? []) tm.ack('t1', b.length);
    await waitFor(
      () =>
        tmux('list-clients', '-t', `=${ns.session}`, '-F', '#{client_width}x#{client_height}').includes(
          '100x30',
        ),
      5000,
      'client size',
    );
    tm.resize('t1', 120, 40);
    await waitFor(
      () =>
        tmux('list-clients', '-t', `=${ns.session}`, '-F', '#{client_width}x#{client_height}').includes(
          '120x40',
        ),
      5000,
      'resized',
    );
    // detach with Ctrl+B d: the channel ends, the session stays
    tm.write('t1', '\x02d');
    await waitFor(() => exits.includes('t1'), 5000, 'detach');
    expect(tmux('has-session', '-t', `=${ns.session}`)).toBe('');
    expect(tmux('list-sessions', '-F', '#{session_name}')).toContain(ns.session);

    // flow control: without acks the channel is paused near HIGH_WATER
    await tm.open({ tabId: 't2', kind: 'shell', cwd: '~', cols: 80, rows: 24 });
    await new Promise((r) => setTimeout(r, 500));
    tm.write('t2', 'yes 0123456789012345678901234567890123456789 | head -c 30000000; echo; echo DONE-MARK\n');
    await waitFor(() => tm.stats('t2')?.paused, 10000, 'paused');
    await new Promise((r) => setTimeout(r, 500));
    const got = (out.get('t2') ?? []).reduce((n, b) => n + b.length, 0);
    expect(got).toBeLessThan(HIGH_WATER * 4);
    // ack everything as the renderer would -> resumes and finishes
    let acked = 0;
    await waitFor(
      () => {
        const total = (out.get('t2') ?? []).reduce((n, b) => n + b.length, 0);
        if (total > acked) {
          tm.ack('t2', total - acked);
          acked = total;
        }
        return text('t2').slice(-4000).includes('DONE-MARK');
      },
      60000,
      'stream finished',
    );
    tm.close('t2');
    await conn.call('kill_session', { session: ns.session }, 10000);
    conn.disconnect();
  }, 120000);

  it('network drop: goes offline and reconnects by itself (backoff), with fresh snapshots', async () => {
    const { conn, states, events } = makeConn(settingsFor(server.port, join(dir, 'id_test')));
    conn.start();
    await waitFor(() => conn.state.kind === 'online', 20000, 'online');
    const n0 = events.length;
    server.dropClients();
    await waitFor(() => states.find((s, i) => i > 0 && s.kind === 'offline'), 10000, 'offline');
    await waitFor(() => conn.state.kind === 'online', 20000, 'reconnected');
    await waitFor(
      () => events.slice(n0).find(([n, d]) => n === 'chats_changed' && (d as { full?: unknown }).full),
      10000,
      'full snapshot',
    );
    // debug drop (socket.destroy without closing channels) behaves the same
    const s1 = states.length;
    conn.debugDrop();
    await waitFor(() => states.slice(s1).find((s) => s.kind === 'offline'), 10000, 'offline 2');
    await waitFor(() => conn.state.kind === 'online', 20000, 'reconnected 2');
    conn.disconnect();
  }, 60000);
});

describe('ssh failures', () => {
  it('refuses a changed host key (no way to continue)', async () => {
    const other = await startServer({ home: fh.home, allowedPublic: key.public });
    // trust key A for other's port, then present key B on the same port
    const known = join(dir, 'known_hosts');
    const { conn, states } = makeConn(settingsFor(other.port, join(dir, 'id_test')));
    conn.start();
    await waitFor(() => states.find((s) => s.kind === 'needs-user'), 15000, 'new key');
    conn.trustHost(true);
    await waitFor(() => conn.state.kind === 'online', 20000, 'online');
    conn.disconnect();
    const port = other.port;
    await other.close();
    const third = await startServer({ home: fh.home, allowedPublic: key.public, port });
    const b = makeConn(settingsFor(port, join(dir, 'id_test')));
    b.conn.start();
    const st = await waitFor(() => b.states.find((s) => s.kind === 'needs-user'), 15000, 'mismatch');
    expect(st).toMatchObject({ reason: 'hostkey-mismatch' });
    b.conn.trustHost(true); // must not add the new key
    expect(
      readFileSync(known, 'utf8')
        .split('\n')
        .filter((l) => l.includes(`]:${port} `)).length,
    ).toBe(1);
    b.conn.disconnect();
    await third.close();
  });

  it('auth rejected -> needs-user auth-rejected with the key fingerprint', async () => {
    const wrong = genKey();
    writeFileSync(join(dir, 'id_wrong'), wrong.private, { mode: 0o600 });
    const { conn, states } = makeConn(settingsFor(server.port, join(dir, 'id_wrong')));
    conn.start();
    const st = await waitFor(() => states.find((s) => s.kind === 'needs-user'), 15000, 'rejected');
    expect(st).toMatchObject({ reason: 'auth-rejected' });
    expect((st as { detail: string }).detail).toMatch(/^SHA256:/);
    conn.disconnect();
  });

  it('encrypted key without agent: asks for the passphrase; wrong one is reported; right one connects', async () => {
    const enc = genKey('secret-pass');
    writeFileSync(join(dir, 'id_enc'), enc.private, { mode: 0o600 });
    const srv = await startServer({ home: fh.home, allowedPublic: enc.public });
    const { conn, states } = makeConn(settingsFor(srv.port, join(dir, 'id_enc')));
    conn.start();
    const st = await waitFor(() => states.find((s) => s.kind === 'needs-user'), 15000, 'agent-empty');
    expect(st).toMatchObject({ reason: 'agent-down' }); // env has no SSH_AUTH_SOCK
    conn.setPassphrase('wrong');
    await waitFor(
      () => states.find((s) => s.kind === 'needs-user' && s.reason === 'passphrase'),
      15000,
      'wrong pass',
    );
    conn.setPassphrase('secret-pass');
    await waitFor(
      () => states.find((s) => s.kind === 'needs-user' && s.reason === 'hostkey-new'),
      15000,
      'host key',
    );
    conn.trustHost(true);
    await waitFor(() => conn.state.kind === 'online', 20000, 'online');
    conn.disconnect();
    await srv.close();
  });

  it('network unreachable -> offline with retry countdown', async () => {
    const { conn, states } = makeConn(settingsFor(1, join(dir, 'id_test')));
    conn.start();
    const st = await waitFor(() => states.find((s) => s.kind === 'offline'), 15000, 'offline');
    expect((st as { error: string }).error).toMatch(/VM недоступна/);
    expect((st as { retryAt: number }).retryAt).toBeGreaterThan(Date.now() - 1000);
    conn.disconnect();
  });

  it('missing ssh config -> needs-user config', async () => {
    const s = parseSettings({}, 'win32');
    s.connection.mode = 'ssh';
    const { conn, states } = makeConn(s);
    conn.start();
    const st = await waitFor(() => states.find((x) => x.kind === 'needs-user'), 5000, 'config');
    expect(st).toMatchObject({ reason: 'config' });
    expect(existsSync(join(dir, 'ssh', 'config'))).toBe(false);
    conn.disconnect();
  });
});
