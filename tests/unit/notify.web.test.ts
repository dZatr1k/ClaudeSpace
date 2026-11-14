import { describe, expect, it } from 'vitest';
import type { ClaudeStatus, Session } from '@shared/model';
import type { DetectorState, DoneEvent } from '../../src/renderer/lib/notify';
import { detectDone, initialDetector, notifyDecision } from '../../src/renderer/lib/notify';
import { applySettingsPatch, defaultSettings, parseSettings } from '../../src/shared/settings';

type Proc = [pid: number, status: ClaudeStatus, chatId?: string];

function snap(spec: Record<string, Proc[]>): Session[] {
  return Object.entries(spec).map(([name, procs]) => ({
    name,
    attached: 1,
    activity: 0,
    windows: 1,
    path: `/home/u/${name}`,
    command: 'claude',
    claude: procs.map(([pid, status, chatId]) => ({
      chatId: chatId ?? `chat-${name}-${pid}`,
      status,
      pid,
      window: '0',
      pane: '%1',
      name: null,
      statusAt: 0,
    })),
  }));
}

/** feed a timeline of [time ms, snapshot, synced?]; returns all events */
function run(steps: [number, Record<string, Proc[]>, boolean?][], st: DetectorState = initialDetector()) {
  const events: (DoneEvent & { at: number })[] = [];
  for (const [at, spec, synced = true] of steps) {
    const r = detectDone(st, snap(spec), synced, at);
    st = r.state;
    events.push(...r.events.map((e) => ({ ...e, at })));
  }
  return { events, state: st };
}

describe('detectDone', () => {
  it('busy -> waiting / idle after >= 3 s busy fires once', () => {
    const { events } = run([
      [0, { A: [[1, 'idle']] }],
      [1000, { A: [[1, 'busy']] }],
      [5000, { A: [[1, 'waiting']] }],
      [6000, { A: [[1, 'waiting']] }],
    ]);
    expect(events).toEqual([{ session: 'A', chatId: 'chat-A-1', kind: 'waiting', busyMs: 4000, at: 5000 }]);
    const idle = run([
      [0, { A: [[1, 'busy']] }],
      [10_000, { A: [[1, 'idle']] }],
    ]).events;
    expect(idle.map((e) => e.kind)).toEqual(['idle']);
  });

  it('short busy blips are ignored', () => {
    const { events } = run([
      [0, { A: [[1, 'waiting']] }],
      [1000, { A: [[1, 'busy']] }],
      [2500, { A: [[1, 'waiting']] }],
    ]);
    expect(events).toEqual([]);
  });

  it('busy duration is measured from the first busy snapshot of the streak', () => {
    const { events } = run([
      [0, { A: [[1, 'idle']] }],
      [1000, { A: [[1, 'busy']] }],
      [2000, { A: [[1, 'busy']] }],
      [3000, { A: [[1, 'busy']] }],
      [4100, { A: [[1, 'waiting']] }],
    ]);
    expect(events.map((e) => e.busyMs)).toEqual([3100]);
  });

  it('flapping within the cooldown fires only once per session', () => {
    const { events } = run([
      [0, { A: [[1, 'idle']] }],
      [1000, { A: [[1, 'busy']] }],
      [5000, { A: [[1, 'waiting']] }], // fires
      [5500, { A: [[1, 'busy']] }],
      [9000, { A: [[1, 'waiting']] }], // 4 s after the last event: suppressed
      [10_000, { A: [[1, 'busy']] }],
      [16_000, { A: [[1, 'idle']] }], // 11 s after: fires again
    ]);
    expect(events.map((e) => [e.at, e.kind])).toEqual([
      [5000, 'waiting'],
      [16_000, 'idle'],
    ]);
  });

  it('the initial snapshot only primes, even if it shows a finished state', () => {
    const { events } = run([
      [0, { A: [[1, 'waiting']], B: [[2, 'idle']] }],
      [1000, { A: [[1, 'waiting']], B: [[2, 'idle']] }],
    ]);
    expect(events).toEqual([]);
  });

  it('cached (unsynced) lists are ignored and the first live snapshot primes', () => {
    // snapshot cache says busy; the first live list says waiting -> no event (we did not see it finish)
    const { events } = run([
      [0, { A: [[1, 'busy']] }, false],
      [10_000, { A: [[1, 'waiting']] }],
    ]);
    expect(events).toEqual([]);
  });

  it('reconnect resets: no event for changes that happened while offline', () => {
    const { events } = run([
      [0, { A: [[1, 'idle']] }],
      [1000, { A: [[1, 'busy']] }],
      [20_000, { A: [[1, 'busy']] }, false], // connection lost (markStale)
      [40_000, { A: [[1, 'waiting']] }], // first live snapshot after reconnect
      [41_000, { A: [[1, 'busy']] }],
      [45_000, { A: [[1, 'idle']] }], // real transition after reconnect
    ]);
    expect(events.map((e) => [e.at, e.kind])).toEqual([[45_000, 'idle']]);
  });

  it('busy time counts from when it was first seen busy (prime included)', () => {
    const { events } = run([
      [0, { A: [[1, 'busy']] }],
      [1000, { A: [[1, 'waiting']] }], // only 1 s seen busy
      [2000, { A: [[1, 'busy']] }],
      [6000, { A: [[1, 'idle']] }],
    ]);
    expect(events.map((e) => e.at)).toEqual([6000]);
  });

  it('multiple sessions are independent; cooldown is per session', () => {
    const { events } = run([
      [0, { A: [[1, 'idle']], B: [[2, 'idle']] }],
      [1000, { A: [[1, 'busy']], B: [[2, 'busy']] }],
      [5000, { A: [[1, 'waiting']], B: [[2, 'idle']] }],
    ]);
    expect(events.map((e) => [e.session, e.kind]).sort()).toEqual([
      ['A', 'waiting'],
      ['B', 'idle'],
    ]);
  });

  it('two Claude processes in one session give one event within the cooldown', () => {
    const { events } = run([
      [
        0,
        {
          A: [
            [1, 'idle'],
            [2, 'idle'],
          ],
        },
      ],
      [
        1000,
        {
          A: [
            [1, 'busy'],
            [2, 'busy'],
          ],
        },
      ],
      [
        5000,
        {
          A: [
            [1, 'waiting'],
            [2, 'idle'],
          ],
        },
      ],
    ]);
    expect(events).toHaveLength(1);
  });

  it('a new process seen for the first time does not fire; unknown statuses are neutral', () => {
    const { events } = run([
      [0, { A: [[1, 'idle']] }],
      [1000, { A: [[1, 'idle']], B: [[2, 'waiting']] }], // B appears waiting: nothing
      [2000, { A: [[1, 'busy']] }],
      [4000, { A: [[1, 'compacting']] }], // unknown value keeps busy streak
      [6000, { A: [[1, 'waiting']] }],
    ]);
    expect(events.map((e) => [e.session, e.busyMs])).toEqual([['A', 4000]]);
  });

  it('a restarted Claude (new pid) starts fresh', () => {
    const { events } = run([
      [0, { A: [[1, 'busy']] }],
      [5000, { A: [[2, 'waiting']] }],
    ]);
    expect(events).toEqual([]);
  });
});

describe('notifyDecision', () => {
  const ev: DoneEvent = { session: 'A', chatId: 'c', kind: 'waiting', busyMs: 5000 };
  const all = { toast: true, sound: true, onlyBackground: true };

  it('silent when the session is in the active tab of a focused window', () => {
    expect(notifyDecision(ev, all, { focused: true, activeSession: 'A' })).toMatchObject({
      toast: false,
      sound: false,
    });
  });
  it('notifies for a background tab or an unfocused window', () => {
    expect(notifyDecision(ev, all, { focused: true, activeSession: 'B' })).toMatchObject({
      toast: true,
      sound: true,
    });
    expect(notifyDecision(ev, all, { focused: true, activeSession: null })).toMatchObject({
      toast: true,
      sound: true,
    });
    expect(notifyDecision(ev, all, { focused: false, activeSession: 'A' })).toMatchObject({
      toast: true,
      sound: true,
    });
  });
  it('onlyBackground off: always; toggles are respected', () => {
    const p = { toast: true, sound: false, onlyBackground: false };
    expect(notifyDecision(ev, p, { focused: true, activeSession: 'A' })).toMatchObject({
      toast: true,
      sound: false,
    });
    expect(
      notifyDecision(
        ev,
        { toast: false, sound: true, onlyBackground: true },
        { focused: false, activeSession: 'A' },
      ),
    ).toMatchObject({ toast: false, sound: true });
  });
  it('Windows notification follows the same background rule', () => {
    const p = { toast: false, sound: true, onlyBackground: true, system: true };
    expect(notifyDecision(ev, p, { focused: true, activeSession: 'A' }).system).toBe(false);
    expect(notifyDecision(ev, p, { focused: false, activeSession: 'A' })).toEqual({
      toast: false,
      sound: true,
      system: true,
    });
  });
});

describe('notification settings', () => {
  it('defaults on, old settings files get defaults, volume validated', () => {
    expect(defaultSettings('win32').notifications).toEqual({
      toast: false,
      sound: true,
      volume: 0.6,
      onlyBackground: true,
      soundFile: '',
      system: true,
    });
    expect(parseSettings({ appearance: { theme: 'dark' } }, 'win32').notifications.sound).toBe(true);
    expect(defaultSettings('linux').notifications).toMatchObject({ toast: true, system: true });
    const s = applySettingsPatch(defaultSettings('win32'), { notifications: { volume: 0.2, sound: false } });
    expect(s.notifications).toMatchObject({ volume: 0.2, sound: false, toast: false, system: true });
    expect(() => applySettingsPatch(s, { notifications: { volume: 2 } })).toThrow();
  });
});
