// "Session finished" detection (BACKLOG #2): pure functions, no DOM/stores — wired up in notifier.ts.
// A Claude process going busy -> waiting/idle is a "done" event, with debounce:
//  - it must have been busy for at least `minBusyMs` (short busy blips are ignored);
//  - one event per tmux session per `cooldownMs` (flapping waiting <-> busy);
//  - the first synced snapshot after (re)connect only primes the state (no events);
//  - processes seen for the first time never fire (unless they later go busy -> done).
import type { Session } from '@shared/model';

export type DoneKind = 'waiting' | 'idle';

export interface DoneEvent {
  session: string;
  chatId: string;
  kind: DoneKind;
  busyMs: number;
}

interface ProcState {
  status: 'busy' | 'waiting' | 'idle';
  /** when we first saw it busy in the current busy streak */
  busySince: number | null;
}

export interface DetectorState {
  primed: boolean;
  procs: Record<string, ProcState>;
  /** last event time per tmux session */
  lastAt: Record<string, number>;
}

export interface DetectorOptions {
  minBusyMs: number;
  cooldownMs: number;
}

export const DEFAULT_DETECTOR: DetectorOptions = { minBusyMs: 3000, cooldownMs: 8000 };

export const initialDetector = (): DetectorState => ({ primed: false, procs: {}, lastAt: {} });

const procKey = (session: string, pid: number, chatId: string) => `${session}\u0000${pid}\u0000${chatId}`;

const known = (s: string): s is ProcState['status'] => s === 'busy' || s === 'waiting' || s === 'idle';

/**
 * Feed one sessions snapshot. `synced` = the list is live from the agent (data store `sessionsSynced`);
 * an unsynced list (cache, connection lost) resets the detector so the next live snapshot only primes it.
 */
export function detectDone(
  st: DetectorState,
  sessions: Session[],
  synced: boolean,
  now: number,
  opts: DetectorOptions = DEFAULT_DETECTOR,
): { state: DetectorState; events: DoneEvent[] } {
  if (!synced) return { state: initialDetector(), events: [] };
  const procs: Record<string, ProcState> = {};
  const events: DoneEvent[] = [];
  const lastAt = { ...st.lastAt };
  for (const s of sessions) {
    for (const c of s.claude) {
      const key = procKey(s.name, c.pid, c.chatId);
      const prev = st.procs[key];
      if (!known(c.status)) {
        // unknown registry value: keep what we knew, don't fire
        if (prev) procs[key] = prev;
        continue;
      }
      if (c.status === 'busy') {
        procs[key] = { status: 'busy', busySince: prev?.status === 'busy' ? prev.busySince : now };
        continue;
      }
      procs[key] = { status: c.status, busySince: null };
      if (!st.primed || prev?.status !== 'busy' || prev.busySince === null) continue;
      const busyMs = now - prev.busySince;
      if (busyMs < opts.minBusyMs) continue;
      const last = lastAt[s.name];
      if (last !== undefined && now - last < opts.cooldownMs) continue;
      lastAt[s.name] = now;
      events.push({ session: s.name, chatId: c.chatId, kind: c.status, busyMs });
    }
  }
  // forget cooldowns that expired long ago (renamed/killed sessions)
  for (const [k, v] of Object.entries(lastAt)) if (now - v > opts.cooldownMs * 4) delete lastAt[k];
  return { state: { primed: true, procs, lastAt }, events };
}

export interface NotifyPrefs {
  /** in-app toast */
  toast: boolean;
  sound: boolean;
  onlyBackground: boolean;
  /** native OS (Windows) notification */
  system?: boolean;
}

export interface NotifyContext {
  /** window has focus (document.hasFocus()) and is visible */
  focused: boolean;
  /** tmux session shown in the active tab, if any */
  activeSession: string | null;
}

/** What to do for an event: nothing, or toast and/or sound. */
export function notifyDecision(
  ev: DoneEvent,
  prefs: NotifyPrefs,
  ctx: NotifyContext,
): { toast: boolean; sound: boolean; system: boolean } {
  const visible = ctx.focused && ctx.activeSession === ev.session;
  if (prefs.onlyBackground && visible) return { toast: false, sound: false, system: false };
  return { toast: prefs.toast, sound: prefs.sound, system: !!prefs.system };
}
