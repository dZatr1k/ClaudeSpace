import { create } from 'zustand';
import type { UpdateState } from '@shared/update';
import { initialUpdateState } from '@shared/update';

/** auto-update state pushed by main (updater.ts); `dismissed` = the version the user postponed with «Позже» */
export const useUpdate = create<{
  state: UpdateState;
  dismissed: string | null;
  set(s: UpdateState): void;
  dismiss(version: string): void;
}>((set) => ({
  state: initialUpdateState,
  dismissed: null,
  set: (state) => set({ state }),
  dismiss: (dismissed) => set({ dismissed }),
}));
