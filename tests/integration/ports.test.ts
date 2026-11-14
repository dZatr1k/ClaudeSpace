// BACKLOG 10 over real SSH (in-process ssh2 Server): a local listener on 127.0.0.1 -> forwardOut (direct-tcpip) ->
// the "VM" port; the listener survives a reconnect and is closed on closeAll.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSettings } from '../../src/shared/settings';
import { Connection } from '../../src/main/connection';
import { PortForwarder } from '../../src/main/ports';
import { BUNDLE, PTY_HELPER, TMUX_SOCKET, makeFakeHome, waitFor } from './helpers';
import type { FakeHome } from './helpers';
import { genKey, startServer } from './sshServer';
import type { TestServer } from './sshServer';

let fh: FakeHome;
let dir: string;
let server: TestServer;
let devServer: Server;
let devPort: number;
const key = genKey();

function roundTrip(port: number, text: string): Promise<string> {
  return new Promise((res, rej) => {
    const s = connect(port, '127.0.0.1', () => s.write(text));
    let buf = '';
    s.on('data', (b) => {
      buf += b.toString();
      if (buf.includes(text)) {
        res(buf);
        s.end();
      }
    });
    s.on('error', rej);
    setTimeout(() => rej(new Error(`timeout, got ${buf}`)), 5000);
  });
}

beforeAll(async () => {
  fh = makeFakeHome();
  dir = mkdtempSync(join(tmpdir(), 'cs-ports-'));
  writeFileSync(join(dir, 'id_test'), key.private, { mode: 0o600 });
  // the "dev server on the VM" (same machine: so the PC side cannot get the same port number)
  devServer = createServer((c) => {
    c.on('error', () => undefined);
    c.write('dev:');
    c.pipe(c);
  });
  await new Promise<void>((r) => devServer.listen(0, '127.0.0.1', () => r()));
  devPort = (devServer.address() as AddressInfo).port;
  server = await startServer({ home: fh.home, allowedPublic: key.public });
});

afterAll(async () => {
  await server?.close();
  await new Promise((r) => devServer.close(r));
  fh?.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe('port forwarding VM -> PC', () => {
  it('forwards over direct-tcpip, survives a reconnect, closes on quit', async () => {
    const s = parseSettings({}, 'win32');
    s.connection.mode = 'ssh';
    s.connection.manual = {
      hostname: '127.0.0.1',
      port: server.port,
      user: 'tester',
      keyPath: join(dir, 'id_test'),
    };
    s.connection.tmuxSocket = `${TMUX_SOCKET}-ports`;
    s.pcLink.tunnel = false;
    const conn = new Connection({
      settings: () => s,
      bundleDir: BUNDLE,
      ptyHelper: PTY_HELPER,
      appKnownHosts: join(dir, 'known_hosts'),
      sshDir: join(dir, 'ssh'),
      platform: 'linux',
      env: {},
    });
    conn.on('state', (st: { kind: string; reason?: string }) => {
      if (st.kind === 'needs-user' && st.reason === 'hostkey-new') setTimeout(() => conn.trustHost(true), 0);
    });
    conn.start();
    await waitFor(() => conn.state.kind === 'online', 20000, 'online');
    const pf = new PortForwarder({ transport: () => conn.transport, settings: () => s });
    const f = await pf.ensure(devPort);
    expect(f.localPort).not.toBe(devPort); // taken on "the PC" (same machine) -> next free
    expect(f.direct).toBe(false);
    expect(await roundTrip(f.localPort, 'one')).toBe('dev:one');
    expect(server.directs).toContain(`127.0.0.1:${devPort}`);
    // network drop: the listener stays; after the reconnect new connections go over the new ssh connection
    server.dropClients();
    await waitFor(() => conn.state.kind !== 'online', 10000, 'offline');
    await waitFor(() => conn.state.kind === 'online', 30000, 'reconnected');
    expect(await roundTrip(f.localPort, 'two')).toBe('dev:two');
    expect(pf.list()).toHaveLength(1);
    await pf.closeAll();
    await expect(roundTrip(f.localPort, 'three')).rejects.toThrow();
    conn.disconnect();
  });
});
