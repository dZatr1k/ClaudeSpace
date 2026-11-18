// «Порт 4173 (vite, MyGame) — открыть?» (BACKLOG 10): which newly appeared ports deserve a toast, and when.
import type { Session } from '@shared/model';
import type { VmPort } from '@shared/protocol';

/** a port must keep listening this long before it is offered: test and helper servers come and go faster */
export const SETTLE_MS = 5000;
/** the same port of the same project is offered again only after this pause (a dev server restarting on save) */
export const REOFFER_MS = 30 * 60_000;

/** prev = null: first list after (re)connect, nothing is "new" yet. Ports the kernel picked (listen on 0) are never
 * offered: dev servers listen on a fixed port, test runners and helpers get a random one. */
export function newProjectPorts(prev: VmPort[] | null, next: VmPort[], sessions: Session[]): VmPort[] {
  if (!prev) return [];
  const had = new Set(prev.map((p) => p.port));
  return next.filter((p) => {
    if (had.has(p.port) || !p.projectPath || p.ephemeral) return false;
    const root = p.projectPath;
    return sessions.some((s) => s.path === root || s.path.startsWith(`${root}/`));
  });
}

/** Feeds on every ports list; calls `offer` for a new project port once it has listened for SETTLE_MS (same pid)
 * and was not offered in the last REOFFER_MS. `now` reads the current ports and sessions when the wait is over. */
export class PortAnnouncer {
  private prev: VmPort[] | null = null;
  private offered = new Map<string, number>();
  private waiting = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly offer: (p: VmPort) => void,
    private readonly now: () => { ports: VmPort[]; sessions: Session[] },
  ) {}

  update(ports: VmPort[], sessions: Session[]): void {
    const fresh = newProjectPorts(this.prev, ports, sessions);
    this.prev = ports;
    for (const p of fresh) {
      if (this.waiting.has(p.port) || this.recent(p)) continue;
      this.waiting.set(
        p.port,
        setTimeout(() => {
          this.waiting.delete(p.port);
          const cur = this.now();
          const still = cur.ports.find((x) => x.port === p.port && x.pid === p.pid);
          // gone, replaced by another process, or its session closed meanwhile
          if (!still || this.recent(still) || !newProjectPorts([], [still], cur.sessions).length) return;
          this.offered.set(key(still), Date.now());
          this.offer(still);
        }, SETTLE_MS),
      );
    }
  }

  /** connection lost: the next list is a baseline again, pending offers are dropped */
  reset(): void {
    this.prev = null;
    for (const t of this.waiting.values()) clearTimeout(t);
    this.waiting.clear();
  }

  private recent(p: VmPort): boolean {
    const at = this.offered.get(key(p));
    return at !== undefined && Date.now() - at < REOFFER_MS;
  }
}

const key = (p: VmPort) => `${p.port}@${p.projectPath ?? ''}`;
