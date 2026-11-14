// BACKLOG 12 over real SSH (in-process ssh2 Server, real agent in a fake HOME): the reverse tunnel (forwardIn ->
// a local fake "sshd" echo server), a port held by someone else (an external tunnel) and its takeover, PC sshd down,
// «Диск ПК» auto-mount and unmount on shutdown with fake winfs/fusermount3 (the real ones are never run).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSettings } from '../../src/shared/settings';
import type { Settings } from '../../src/shared/settings';
import { Connection } from '../../src/main/connection';
import { PcLink } from '../../src/main/pclink';
import { BUNDLE, PTY_HELPER, TMUX_SOCKET, makeFakeHome, waitFor } from './helpers';
import type { FakeHome } from './helpers';
import { genKey, startServer } from './sshServer';
import type { TestServer } from './sshServer';

const FAKE_WINFS = `#!/bin/sh
echo "winfs $*" >> "$HOME/calls.log"
src=$1; dst=$2
mkdir -p "$dst"
n=$(wc -l < "$CSAGENT_MOUNTINFO")
echo "$((100 + n)) 1 0:$((60 + n)) / $dst rw - fuse.sshfs winpc:/$src rw" >> "$CSAGENT_MOUNTINFO"
`;
const FAKE_FUSERMOUNT = `#!/bin/sh
echo "fusermount3 $*" >> "$HOME/calls.log"
for a; do dst=$a; done
grep -v " $dst rw" "$CSAGENT_MOUNTINFO" > "$CSAGENT_MOUNTINFO.tmp"; mv "$CSAGENT_MOUNTINFO.tmp" "$CSAGENT_MOUNTINFO"
`;

let fh: FakeHome;
let dir: string;
let server: TestServer;
let sshd: Server;
let sshdPort: number;
const key = genKey();
const sockets = new Set<Socket>();

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

function echoServer(port = 0): Promise<Server> {
  return new Promise((res) => {
    const s = createServer((c) => {
      sockets.add(c);
      c.on('close', () => sockets.delete(c));
      c.on('error', () => undefined);
      c.write('SSH-2.0-FakeWindowsSshd\r\n');
      c.pipe(c);
    });
    s.listen(port, '127.0.0.1', () => res(s));
  });
}

function closeServer(s: Server): Promise<void> {
  for (const c of sockets) c.destroy();
  return new Promise((r) => s.close(() => r()));
}

function settingsFor(port: number): Settings {
  const s = parseSettings({}, 'win32');
  s.connection.mode = 'ssh';
  s.connection.manual = { hostname: '127.0.0.1', port, user: 'tester', keyPath: join(dir, 'id_test') };
  s.connection.tmuxSocket = `${TMUX_SOCKET}-pl`;
  s.pcLink.mounts = [{ src: 'C:\\Data', dst: '~/winfs/V' }];
  return s;
}

async function online(settings: Settings, tunnelPort: number) {
  const conn = new Connection({
    settings: () => settings,
    bundleDir: BUNDLE,
    ptyHelper: PTY_HELPER,
    appKnownHosts: join(dir, 'known_hosts'),
    sshDir: join(dir, 'ssh'),
    platform: 'linux',
    env: {},
  });
  const logs: string[] = [];
  const link = new PcLink({
    conn,
    settings: () => settings,
    pcPort: sshdPort,
    tunnelPort,
    retryMs: 300,
    log: (...a: unknown[]) => logs.push(a.join(' ')),
  }).attach();
  conn.on('state', (s: { kind: string; reason?: string }) => {
    if (s.kind === 'needs-user' && s.reason === 'hostkey-new') setTimeout(() => conn.trustHost(true), 0);
  });
  conn.start();
  await waitFor(() => conn.state.kind === 'online', 20000, 'online');
  return { conn, link, logs };
}

function readAll(ch: Duplex, want: string, ms = 5000): Promise<string> {
  return new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error(`timeout, got ${JSON.stringify(buf)}`)), ms);
    ch.on('data', (b: Buffer) => {
      buf += b.toString();
      if (buf.includes(want)) {
        clearTimeout(t);
        res(buf);
      }
    });
  });
}

beforeAll(async () => {
  fh = makeFakeHome();
  dir = mkdtempSync(join(tmpdir(), 'cs-pclink-'));
  writeFileSync(join(dir, 'id_test'), key.private, { mode: 0o600 });
  // fake winfs/fusermount3 in the fake HOME + a fake mountinfo the agent reads (inherited by the server's execs)
  const lb = join(fh.home, '.local', 'bin');
  mkdirSync(lb, { recursive: true });
  writeFileSync(join(lb, 'winfs'), FAKE_WINFS);
  writeFileSync(join(lb, 'fusermount3'), FAKE_FUSERMOUNT);
  chmodSync(join(lb, 'winfs'), 0o755);
  chmodSync(join(lb, 'fusermount3'), 0o755);
  process.env.CSAGENT_MOUNTINFO = join(dir, 'mountinfo');
  writeFileSync(join(dir, 'mountinfo'), '22 1 8:1 / / rw - ext4 /dev/vda1 rw\n');
  sshd = await echoServer();
  sshdPort = (sshd.address() as AddressInfo).port;
  server = await startServer({ home: fh.home, allowedPublic: key.public });
});

afterAll(async () => {
  await server?.close();
  if (sshd?.listening) await closeServer(sshd);
  delete process.env.CSAGENT_MOUNTINFO;
  fh?.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe('reverse tunnel + Диск ПК', () => {
  it('forwards VM:port to the PC sshd, auto-mounts, unmounts on shutdown', async () => {
    const tport = await freePort();
    const { conn, link } = await online(settingsFor(server.port), tport);
    await waitFor(() => link.state.tunnel === 'ours', 10000, 'tunnel ours');
    expect(server.forwards.get(tport)).toBe('127.0.0.1'); // loopback only, never 0.0.0.0
    // a "win" connection on the VM side reaches the PC's sshd and data flows both ways
    const ch = await server.openForwarded(tport);
    await readAll(ch, 'SSH-2.0-FakeWindowsSshd');
    ch.write('ping-123');
    await readAll(ch, 'ping-123');
    await waitFor(() => link.state.conns === 1, 3000, 'conns');
    ch.end();
    await waitFor(() => link.state.conns === 0, 5000, 'conn closed');
    expect(link.state.sshd).toBe('ok');
    // configured mount C:\Data -> ~/winfs/V, mounted by us
    await waitFor(() => link.state.mounts[0]?.mounted, 15000, 'mounted');
    expect(link.state.mounts[0]).toMatchObject({ label: 'V', owned: true, error: null });
    const calls = () => readFileSync(join(fh.home, 'calls.log'), 'utf8');
    expect(calls()).toContain(`winfs C:/Data ${fh.home}/winfs/V`);
    // quit: lazy unmount of our mount, forward cancelled
    await link.shutdown();
    expect(calls()).toContain(`fusermount3 -u -z ${fh.home}/winfs/V`);
    expect(readFileSync(join(dir, 'mountinfo'), 'utf8')).not.toContain('winfs/V');
    await waitFor(() => !server.forwards.has(tport), 3000, 'unforwarded');
    conn.disconnect();
    await waitFor(() => link.state.tunnel === 'waiting', 3000, 'waiting');
  });

  it('port held by another tunnel: shows it, does not bind, takes over when it is gone', async () => {
    // an external tunnel holder: a real listener on the port that answers with an SSH banner
    const guard = await echoServer(0);
    const tport = (guard.address() as AddressInfo).port;
    const s = settingsFor(server.port);
    s.pcLink.autoMount = false;
    const { conn, link } = await online(s, tport);
    await waitFor(() => link.state.tunnel === 'foreign', 10000, 'foreign');
    expect(link.state.detail).toContain('внешний туннель');
    expect(link.state.nextTryAt).toBeGreaterThan(Date.now() - 1000);
    expect(server.forwards.has(tport)).toBe(false); // looked first, did not try to bind
    await closeServer(guard);
    await waitFor(() => link.state.tunnel === 'ours', 10000, 'took over');
    expect(server.forwards.get(tport)).toBe('127.0.0.1');
    await link.shutdown();
    conn.disconnect();
  });

  it('server refuses the forward -> clear error and retries; PC sshd down -> rejected at once, state says so', async () => {
    const tport = await freePort();
    const busy = await startServer({ home: fh.home, allowedPublic: key.public, busyPorts: new Set([tport]) });
    try {
      const s = settingsFor(busy.port);
      s.pcLink.autoMount = false;
      const { conn, link, logs } = await online(s, tport);
      await waitFor(() => link.state.tunnel === 'error', 10000, 'error');
      expect(link.state.detail).toContain(String(tport));
      conn.disconnect();
      // sshd down: through a working tunnel the connection is refused quickly, not hung
      await closeServer(sshd);
      const ok = await online(settingsFor(server.port), tport);
      await waitFor(() => ok.link.state.tunnel === 'ours', 10000, 'ours');
      await waitFor(() => ok.link.state.sshd === 'down', 5000, 'sshd down');
      const ch = await server.openForwarded(tport).catch((e: Error) => e);
      if (!(ch instanceof Error)) await new Promise((r) => ch.once('close', r));
      expect(ok.logs.filter((l) => l.includes('PC sshd down')).length).toBe(1);
      expect(logs.length).toBeGreaterThan(0);
      sshd = await echoServer(sshdPort);
      await ok.link.shutdown();
      ok.conn.disconnect();
    } finally {
      await busy.close();
    }
  });

  it('local transport: no tunnel', async () => {
    const s = parseSettings({}, 'linux');
    expect(s.pcLink.tunnel).toBe(false);
    expect(parseSettings({}, 'win32').pcLink).toMatchObject({
      tunnel: true,
      autoMount: true,
      mounts: [],
    });
  });
});
