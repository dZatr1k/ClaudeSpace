import { create } from 'zustand';
import type { ForwardInfo } from '@shared/ports';

/** active forwards VM -> PC, pushed by main (ports.ts) */
export const usePorts = create<{ forwards: ForwardInfo[]; set(f: ForwardInfo[]): void }>((set) => ({
  forwards: [],
  set: (forwards) => set({ forwards }),
}));
