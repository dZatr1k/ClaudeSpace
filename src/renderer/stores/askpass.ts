import { create } from 'zustand';
import type { AskpassRequest } from '@shared/askpass';

/** sudo prompts waiting for the user (BACKLOG 11). Only the requests — never a password. One modal at a time: the
 *  first in the queue is shown, the rest wait. */
export interface AskpassState {
  queue: AskpassRequest[];
  add(req: AskpassRequest): void;
  remove(id: string): void;
  clear(): void;
}

export const MAX_QUEUE = 16;

export function enqueue(q: AskpassRequest[], req: AskpassRequest): AskpassRequest[] {
  if (q.some((x) => x.id === req.id)) return q;
  return [...q, req].slice(-MAX_QUEUE);
}

export function dequeue(q: AskpassRequest[], id: string): AskpassRequest[] {
  return q.some((x) => x.id === id) ? q.filter((x) => x.id !== id) : q;
}

export const useAskpass = create<AskpassState>((set) => ({
  queue: [],
  add: (req) => set((s) => ({ queue: enqueue(s.queue, req) })),
  remove: (id) => set((s) => ({ queue: dequeue(s.queue, id) })),
  clear: () => set({ queue: [] }),
}));
