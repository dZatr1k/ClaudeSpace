// BACKLOG 10: URL rewriting, local port choice, the forwarder over a fake transport, new-port toasts.
import { createServer, connect } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidatePorts, mapLocalUrl, parseLocalUrl } from '../../src/shared/ports';
import { parseSettings } from '../../src/shared/settings';
import { PortForwarder } from '../../src/main/ports';
import type { Transport } from '../../src/main/transport/types';

describe('local URLs', () => {
  it('parses localhost / 127.0.0.1 / 0.0.0.0 / [::1] and nothing else', () => {
    expect(parseLocalUrl('http://localhost:5173/')).toEqual({
      scheme: 'http',
      host: 'localhost',
      port: 5173,
      rest: '/',
    });
    expect(parseLocalUrl('http://127.0.0.1:8080/a?b=1#c')?.rest).toBe('/a?b=1#c');
    expect(parseLocalUrl('https://0.0.0.0:4173')?.port).toBe(4173);
    expect(parseLocalUrl('http://[::1]:3000/x')?.host).toBe('[::1]');
    expect(parseLocalUrl('http://localhost/')?.port).toBe(80);
    expect(parseLocalUrl('https://localhost')?.port).toBe(443);
    for (const bad of [
      'http://example.com:5173/',
      'http://localhost.evil.com:80/',
      'http://192.168.1.5:3000/',
      'ftp://localhost:21/',
      'http://localhost:70000/',
      'http://localhost:0/',
      'javascript:alert(1)',
      'http://user@localhost:80/',
    ])
      expect(parseLocalUrl(bad), bad).toBeNull();
  });

  it('maps the port and keeps the path; 0.0.0.0 becomes localhost', () => {
    const u = parseLocalUrl('http://0.0.0.0:5173/app/?x=1') as NonNullable<ReturnType<typeof parseLocalUrl>>;
    expect(mapLocalUrl(u, 5174)).toBe('http://localhost:5174/app/?x=1');
    const v = parseLocalUrl('http://127.0.0.1:8080/') as NonNullable<ReturnType<typeof parseLocalUrl>>;
    expect(mapLocalUrl(v, 8080)).toBe('http://127.0.0.1:8080/');
  });

  it('tries the same port first, then the next 20, never past 65535', () => {
    expect(candidatePorts(4173).slice(0, 3)).toEqual([4173, 4174, 4175]);
    expect(candidatePorts(4173)).toHaveLength(21);
    expect(candidatePorts(65530)).toEqual([65530, 65531, 65532, 65533, 65534, 65535]);
  });
});

describe('PortForwarder over a fake transport', () => {
  let echo: Server;
  let echoPort: number;
  let blocker: Server;
  const calls: string[] = [];
  const settings = parseSettings({}, 'win32');
  // "VM side": forwardOut connects to the local echo server, wherever the test says the VM port is
  const transport = Object.assign(new EventEmitter(), {
    kind: 'ssh' as const,
    forwardOut: (src: string, _sp: number, dst: string, dport: number) =>
      new Promise((res, rej) => {
        calls.push(`${src}->${dst}:${dport}`);
        const s = connect(echoPort, '127.0.0.1');
        s.once('connect', () => res(s));
        s.once('error', rej);
      }),
  }) as unknown as Transport;

  beforeAll(async () => {
    echo = createServer((c) => c.pipe(c));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    echoPort = (echo.address() as AddressInfo).port;
    blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
  });
  afterAll(async () => {
    await new Promise((r) => echo.close(r));
    await new Promise((r) => blocker.close(r));
  });

  it('binds 127.0.0.1, same port if free, else the next one; pipes through forwardOut', async () => {
    const pf = new PortForwarder({ transport: () => transport, settings: () => settings });
    const taken = (blocker.address() as AddressInfo).port;
    const f = await pf.ensure(taken);
    expect(f.localPort).not.toBe(taken);
    expect(f.localPort).toBeGreaterThan(taken);
    expect(f.vmPort).toBe(taken);
    expect(await pf.ensure(taken)).toEqual(f); // idempotent
    const got = await new Promise<string>((res) => {
      const s = connect(f.localPort, '127.0.0.1', () => s.write('hello'));
      s.on('data', (b) => {
        res(b.toString());
        s.end();
      });
    });
    expect(got).toBe('hello');
    expect(calls.at(-1)).toBe(`127.0.0.1->127.0.0.1:${taken}`);
    // a ::1-only dev server is reached on the VM's ::1
    pf.setVmPorts([
      { port: taken, addr: '::1', pid: 1, name: 'vite', cwd: null, project: null, projectPath: null },
    ]);
    await new Promise<void>((res) => {
      const s = connect(f.localPort, '127.0.0.1', () => s.end());
      s.on('close', () => res());
    });
    expect(calls.at(-1)).toBe(`127.0.0.1->::1:${taken}`);
    await pf.closeAll();
    expect(pf.list()).toEqual([]);
    await expect(
      new Promise((res, rej) => connect(f.localPort, '127.0.0.1').once('connect', res).once('error', rej)),
    ).rejects.toThrow();
  });

  it('local mode: no listener, the VM port is used directly; offline -> error', async () => {
    const local = Object.assign(new EventEmitter(), { kind: 'local' as const }) as unknown as Transport;
    const pf = new PortForwarder({ transport: () => local, settings: () => settings });
    expect(await pf.ensure(5173)).toMatchObject({ vmPort: 5173, localPort: 5173, direct: true });
    const off = new PortForwarder({ transport: () => null, settings: () => settings });
    await expect(off.ensure(5173)).rejects.toThrow('нет связи');
    await expect(off.ensure(0)).rejects.toThrow();
  });
});
