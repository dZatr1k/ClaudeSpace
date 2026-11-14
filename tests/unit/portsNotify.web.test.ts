// BACKLOG 10: which new VM ports get a «Порт N (…) — открыть?» toast.
import { describe, expect, it } from 'vitest';
import type { Session } from '@shared/model';
import type { VmPort } from '@shared/protocol';
import { newProjectPorts } from '../../src/renderer/lib/portsNotify';

describe('new-port toast', () => {
  const port = (n: number, projectPath: string | null): VmPort => ({
    port: n,
    addr: '127.0.0.1',
    pid: 1,
    name: 'vite',
    cwd: projectPath,
    project: projectPath ? 'MyGame' : null,
    projectPath,
  });
  const sess = (path: string) => ({ name: 's', path }) as unknown as Session;
  it('only new ports of projects with an open session, never on the first list', () => {
    const gd = '/home/u/projects/MyGame';
    expect(newProjectPorts(null, [port(4173, gd)], [sess(gd)])).toEqual([]);
    expect(newProjectPorts([], [port(4173, gd)], [sess(`${gd}/web`)]).map((p) => p.port)).toEqual([4173]);
    expect(newProjectPorts([port(4173, gd)], [port(4173, gd)], [sess(gd)])).toEqual([]);
    expect(newProjectPorts([], [port(4173, gd)], [sess('/home/u/projects/MyGameX')])).toEqual([]);
    expect(newProjectPorts([], [port(9000, null)], [sess(gd)])).toEqual([]);
  });
});
