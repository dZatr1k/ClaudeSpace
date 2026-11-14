import { create } from 'zustand';
import type { ConnState } from '@shared/model';

interface ConnStore {
  state: ConnState;
  everOnline: boolean;
  set(s: ConnState): void;
}

export const useConn = create<ConnStore>((set) => ({
  state: { kind: 'idle' },
  everOnline: false,
  set: (s) => set((st) => ({ state: s, everOnline: st.everOnline || s.kind === 'online' })),
}));

export const isOnline = () => useConn.getState().state.kind === 'online';
