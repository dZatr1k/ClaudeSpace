import { create } from 'zustand';
import type { PcLinkState } from '@shared/pclink';
import { initialPcLinkState } from '@shared/pclink';

/** PC <-> VM link (reverse tunnel + «Диск ПК»), pushed by main (pclink.ts) */
export const usePcLink = create<{ state: PcLinkState; set(s: PcLinkState): void }>((set) => ({
  state: initialPcLinkState,
  set: (state) => set({ state }),
}));
