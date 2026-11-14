// In-process ssh2 Server for tests: public-key auth for one generated key, exec (with optional PTY via the same
// Python helper), minimal SFTP (open/write/close/setstat) rooted at a fake HOME. No change to ~/.ssh.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, chmodSync, fchmodSync, openSync, writeSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { isAbsolute, join } from 'node:path';
import type { Writable } from 'node:stream';
import { Server, utils } from 'ssh2';
import type { Connection, ParsedKey } from 'ssh2';
import { PTY_HELPER } from './helpers';

export interface TestServer {
  port: number;
  hostKey: string;
  close(): Promise<void>;
  /** destroy every client socket (network drop) */
  dropClients(): void;
  execs: string[];
  /** remote forwards the client asked for (tcpip-forward): port -> bind address */
  forwards: Map<number, string>;
  /** simulate a connection to a forwarded port on the "VM": the client gets 'tcp connection' */
  openForwarded(port: number): Promise<Duplex>;
  /** direct-tcpip requests (client forwardOut): "host:port" */
  directs: string[];
}

export function genKey(passphrase?: string): { private: string; public: string } {
  const k = passphrase
    ? utils.generateKeyPairSync('ed25519', { passphrase, cipher: 'aes256-ctr', rounds: 4 } as never)
    : utils.generateKeyPairSync('ed25519', {} as never);
  return { private: k.private, public: k.public };
}

export function startServer(opts: {
  home: string;
  allowedPublic: string;
  hostKey?: string;
  port?: number;
  /** tcpip-forward on these ports is refused (already bound on the "VM") */
  busyPorts?: Set<number>;
}): Promise<TestServer> {
  const hostKey = opts.hostKey ?? genKey().private;
  const allowed = utils.parseKey(opts.allowedPublic) as ParsedKey;
  const clients = new Set<Connection>();
  const execs: string[] = [];
  const procs = new Set<ChildProcess>();
  const forwards = new Map<number, string>();
  const forwardOwner = new Map<number, Connection>();
  const directs: string[] = [];
  const resolvePath = (p: string) => (isAbsolute(p) ? p : join(opts.home, p));

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey') return ctx.reject(['publickey']);
      const same = ctx.key.algo === allowed.type && ctx.key.data.equals(allowed.getPublicSSH());
      if (!same) return ctx.reject(['publickey']);
      if (ctx.signature && ctx.blob) {
        if (allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(['publickey']);
      }
      ctx.accept();
    });
    client.on('ready', () => {
      client.on('request', (accept, reject, name, info) => {
        const i = info as { bindAddr: string; bindPort: number };
        if (name === 'tcpip-forward') {
          if (opts.busyPorts?.has(i.bindPort) || forwards.has(i.bindPort)) return reject?.();
          forwards.set(i.bindPort, i.bindAddr);
          forwardOwner.set(i.bindPort, client);
          return accept?.(i.bindPort);
        }
        if (name === 'cancel-tcpip-forward') {
          forwards.delete(i.bindPort);
          forwardOwner.delete(i.bindPort);
          return accept?.();
        }
        reject?.();
      });
      client.on('close', () => {
        for (const [port, c] of forwardOwner)
          if (c === client) {
            forwards.delete(port);
            forwardOwner.delete(port);
          }
      });
      client.on('tcpip', (accept, reject, info) => {
        directs.push(`${info.destIP}:${info.destPort}`);
        const sock = netConnect({ host: info.destIP, port: info.destPort });
        sock.once('connect', () => {
          const ch = accept();
          sock.pipe(ch);
          ch.pipe(sock);
          ch.on('close', () => sock.destroy());
          sock.on('close', () => ch.end());
          ch.on('error', () => sock.destroy());
        });
        sock.once('error', () => reject());
      });
      client.on('session', (accept) => {
        const session = accept();
        let pty: { cols: number; rows: number } | null = null;
        let ctl: Writable | null = null;
        session.on('pty', (acc, _rej, info) => {
          pty = { cols: info.cols, rows: info.rows };
          acc?.();
        });
        session.on('window-change', (acc, _rej, info) => {
          ctl?.write(`${info.rows} ${info.cols}\n`);
          acc?.();
        });
        session.on('exec', (acc, _rej, info) => {
          const stream = acc();
          execs.push(info.command);
          const env: NodeJS.ProcessEnv = { ...process.env, HOME: opts.home, TERM: 'xterm-256color' };
          delete env.TMUX;
          const proc = pty
            ? spawn(
                'python3',
                ['-I', PTY_HELPER, String(pty.rows), String(pty.cols), '/bin/bash', '-c', info.command],
                {
                  cwd: opts.home,
                  env,
                  stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
                },
              )
            : spawn('/bin/bash', ['-c', info.command], {
                cwd: opts.home,
                env,
                stdio: ['pipe', 'pipe', 'pipe'],
              });
          procs.add(proc);
          ctl = pty ? (proc.stdio[3] as Writable) : null;
          ctl?.on('error', () => undefined);
          proc.stdout?.pipe(stream, { end: false });
          proc.stderr?.pipe(stream.stderr, { end: false });
          stream.pipe(proc.stdin as Writable);
          proc.stdin?.on('error', () => undefined);
          stream.on('close', () => proc.kill('SIGHUP'));
          proc.on('close', (code) => {
            procs.delete(proc);
            try {
              stream.exit(code ?? 1);
              stream.end();
            } catch {
              /* client gone */
            }
          });
        });
        session.on('sftp', (acc) => {
          const sftp = acc();
          const S = utils.sftp.STATUS_CODE;
          const handles = new Map<number, number>();
          let next = 1;
          sftp.on('OPEN', (id, filename, _flags, attrs) => {
            try {
              const fd = openSync(resolvePath(filename), 'w', attrs?.mode ?? 0o600);
              const h = next++;
              handles.set(h, fd);
              const b = Buffer.alloc(4);
              b.writeUInt32BE(h);
              sftp.handle(id, b);
            } catch {
              sftp.status(id, S.FAILURE);
            }
          });
          sftp.on('WRITE', (id, handle, offset, data) => {
            const fd = handles.get(handle.readUInt32BE(0));
            if (fd === undefined) return sftp.status(id, S.FAILURE);
            writeSync(fd, data, 0, data.length, offset);
            sftp.status(id, S.OK);
          });
          sftp.on('FSETSTAT', (id, handle, attrs) => {
            const fd = handles.get(handle.readUInt32BE(0));
            if (fd !== undefined && attrs.mode !== undefined) fchmodSync(fd, attrs.mode & 0o7777);
            sftp.status(id, S.OK);
          });
          sftp.on('SETSTAT', (id, path, attrs) => {
            try {
              if (attrs.mode !== undefined) chmodSync(resolvePath(path), attrs.mode & 0o7777);
              sftp.status(id, S.OK);
            } catch {
              sftp.status(id, S.FAILURE);
            }
          });
          sftp.on('CLOSE', (id, handle) => {
            const h = handle.readUInt32BE(0);
            const fd = handles.get(h);
            if (fd !== undefined) closeSync(fd);
            handles.delete(h);
            sftp.status(id, S.OK);
          });
        });
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        hostKey,
        execs,
        forwards,
        directs,
        openForwarded: (fport: number) =>
          new Promise<Duplex>((res, rej) => {
            const c = forwardOwner.get(fport);
            if (!c) return rej(new Error(`no forward on ${fport}`));
            c.forwardOut(forwards.get(fport) as string, fport, '127.0.0.1', 40000, (err, ch) =>
              err ? rej(err) : res(ch as unknown as Duplex),
            );
          }),
        dropClients: () => {
          for (const c of clients) (c as unknown as { _sock: { destroy(): void } })._sock.destroy();
        },
        close: () =>
          new Promise<void>((r) => {
            for (const p of procs) p.kill('SIGKILL');
            for (const c of clients) c.end();
            server.close(() => r());
          }),
      });
    });
  });
}
