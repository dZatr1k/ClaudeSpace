// BACKLOG 10: which new VM ports get a «Порт N (…) — открыть?» toast, and when.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@shared/model';
import type { VmPort } from '@shared/protocol';
import { PortAnnouncer, REOFFER_MS, SETTLE_MS, newProjectPorts } from '../../src/renderer/lib/portsNotify';

const gd = '/home/u/projects/MyGame';
const port = (n: number, projectPath: string | null = gd, extra: Partial<VmPort> = {}): VmPort => ({
  port: n,
  addr: '127.0.0.1',
  pid: 1,
  name: 'vite',
  cwd: projectPath,
  project: projectPath ? 'MyGame' : null,
  projectPath,
  ephemeral: false,
  ...extra,
});
const sess = (path: string) => ({ name: 's', path }) as unknown as Session;

describe('newProjectPorts', () => {
  it('only new ports of projects with an open session, never on the first list', () => {
    expect(newProjectPorts(null, [port(4173)], [sess(gd)])).toEqual([]);
    expect(newProjectPorts([], [port(4173)], [sess(`${gd}/web`)]).map((p) => p.port)).toEqual([4173]);
    expect(newProjectPorts([port(4173)], [port(4173)], [sess(gd)])).toEqual([]);
    expect(newProjectPorts([], [port(4173)], [sess('/home/u/projects/MyGameX')])).toEqual([]);
    expect(newProjectPorts([], [port(9000, null)], [sess(gd)])).toEqual([]);
  });
  it('skips ports the kernel picked (test runners, helper servers)', () => {
    expect(newProjectPorts([], [port(45687, gd, { name: 'vitest', ephemeral: true })], [sess(gd)])).toEqual(
      [],
    );
    // an older agent without the flag still counts as a fixed port
    expect(newProjectPorts([], [port(5173, gd, { ephemeral: undefined })], [sess(gd)])).toHaveLength(1);
  });
});

describe('PortAnnouncer', () => {
  let ports: VmPort[];
  let sessions: Session[];
  let offered: number[];
  let a: PortAnnouncer;
  const feed = (next: VmPort[]) => {
    ports = next;
    a.update(ports, sessions);
  };
  beforeEach(() => {
    vi.useFakeTimers();
    ports = [];
    sessions = [sess(gd)];
    offered = [];
    a = new PortAnnouncer(
      (p) => offered.push(p.port),
      () => ({ ports, sessions }),
    );
    feed([]); // baseline after connect
  });
  afterEach(() => vi.useRealTimers());

  it('offers a port only after it has listened for SETTLE_MS', () => {
    feed([port(4173)]);
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(offered).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(offered).toEqual([4173]);
  });

  it('drops a port that closed or changed owner before the wait was over', () => {
    feed([port(4173)]);
    feed([]);
    vi.advanceTimersByTime(SETTLE_MS);
    feed([port(5173, gd, { pid: 2 })]);
    ports = [port(5173, gd, { pid: 3 })]; // restarted under another pid: wait again from the next list
    vi.advanceTimersByTime(SETTLE_MS);
    expect(offered).toEqual([]);
  });

  it('does not offer the same port of the same project again for REOFFER_MS (restart on save)', () => {
    feed([port(4173)]);
    vi.advanceTimersByTime(SETTLE_MS);
    for (let i = 0; i < 3; i++) {
      feed([]);
      feed([port(4173, gd, { pid: 10 + i })]);
      vi.advanceTimersByTime(SETTLE_MS);
    }
    expect(offered).toEqual([4173]);
    vi.advanceTimersByTime(REOFFER_MS);
    feed([]);
    feed([port(4173, gd, { pid: 99 })]);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(offered).toEqual([4173, 4173]);
  });

  it('a burst of test servers on random ports offers nothing', () => {
    for (const n of [45687, 45689, 39121, 41003])
      feed([...ports, port(n, gd, { name: 'vitest', ephemeral: true })]);
    vi.advanceTimersByTime(SETTLE_MS * 2);
    expect(offered).toEqual([]);
  });

  it('nothing pending survives a reconnect, and the first list after it is a baseline', () => {
    feed([port(4173)]);
    a.reset();
    vi.advanceTimersByTime(SETTLE_MS);
    feed([port(4173), port(5173)]);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(offered).toEqual([]);
  });

  it('skips a port whose session was closed during the wait', () => {
    feed([port(4173)]);
    sessions = [];
    vi.advanceTimersByTime(SETTLE_MS);
    expect(offered).toEqual([]);
  });
});
