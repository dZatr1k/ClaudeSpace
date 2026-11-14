// Mapping Claude/tmux state to UI status (DESIGN §5.2): busy | waiting | idle | none | error | offline.
import type { ClaudeProc, ClaudeStatus, Session, UiStatus } from '@shared/model';
import { formatClock, formatDuration } from './format';

export function claudeUi(status: ClaudeStatus | null | undefined): UiStatus {
  if (status === 'busy' || status === 'waiting' || status === 'idle') return status as UiStatus;
  return 'idle';
}

/** unknown registry values (Claude Code added a new one): shown grey with the raw word */
export function isUnknownStatus(status: ClaudeStatus | null | undefined): boolean {
  return !!status && status !== 'busy' && status !== 'waiting' && status !== 'idle';
}

export function sessionStatus(s: Session): { ui: UiStatus; raw: ClaudeStatus | null } {
  if (!s.claude.length) return { ui: 'none', raw: null };
  const order = ['waiting', 'busy', 'idle'];
  const best = [...s.claude].sort((a, b) => {
    const ia = order.indexOf(a.status);
    const ib = order.indexOf(b.status);
    return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib);
  })[0];
  return { ui: claudeUi(best?.status), raw: best?.status ?? null };
}

export function sortSessions(list: Session[]): Session[] {
  const rank = (s: Session) => {
    const st = sessionStatus(s).raw;
    return st === 'waiting' ? 0 : st === 'busy' ? 1 : 2;
  };
  return [...list].sort((a, b) => rank(a) - rank(b) || b.activity - a.activity);
}

/** The Claude a session is "about" (same order as sessionStatus: waiting > busy > idle, then the freshest). */
export function primaryClaude(s: Session): ClaudeProc | null {
  const order = ['waiting', 'busy', 'idle'];
  const rank = (c: ClaudeProc) => {
    const i = order.indexOf(c.status);
    return i < 0 ? 9 : i;
  };
  return [...s.claude].sort((a, b) => rank(a) - rank(b) || b.statusAt - a.statusAt)[0] ?? null;
}

/** «думает 2 мин» / «ждёт ответа с 14:05» / «простаивает»; unknown registry values as the raw word. */
export function statusLine(status: ClaudeStatus, statusAt: number, now = Date.now()): string {
  if (status === 'busy') return statusAt ? `думает ${formatDuration(Math.max(0, now - statusAt))}` : 'думает';
  if (status === 'waiting') return statusAt ? `ждёт ответа с ${formatClock(statusAt, now)}` : 'ждёт ответа';
  if (status === 'idle') return 'простаивает';
  return String(status);
}
