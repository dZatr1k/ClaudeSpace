// «Порт 4173 (vite, MyGame) — открыть?» (BACKLOG 10): which newly appeared ports deserve a toast. Pure.
import type { Session } from '@shared/model';
import type { VmPort } from '@shared/protocol';

/** prev = null: first list after (re)connect — nothing is "new" yet */
export function newProjectPorts(prev: VmPort[] | null, next: VmPort[], sessions: Session[]): VmPort[] {
  if (!prev) return [];
  const had = new Set(prev.map((p) => p.port));
  return next.filter((p) => {
    if (had.has(p.port) || !p.projectPath) return false;
    const root = p.projectPath;
    return sessions.some((s) => s.path === root || s.path.startsWith(`${root}/`));
  });
}
