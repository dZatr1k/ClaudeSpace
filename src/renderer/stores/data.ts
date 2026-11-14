// Lists from the VM, updated by agent events (never polled by the UI).
import { create } from 'zustand';
import type {
  Chat,
  DoctorWarning,
  Hello,
  Project,
  Session,
  Snapshot,
  SystemStats,
  Usage,
} from '@shared/model';
import type { VmPort } from '@shared/protocol';

export interface DataState {
  sessions: Session[];
  chats: Record<string, Chat>;
  projects: Project[];
  system: SystemStats | null;
  doctor: DoctorWarning | null;
  usage: Usage | null;
  hello: Hello | null;
  /** lists come from the snapshot cache / last connection, not live */
  stale: boolean;
  staleAt: number | null;
  /** an active_changed arrived since the last (re)connect */
  sessionsSynced: boolean;
  /** listening TCP ports of the user's processes on the VM (BACKLOG 10) */
  ports: VmPort[];
}

interface DataStore extends DataState {
  loadSnapshot(s: Snapshot | null): void;
  apply(event: string, data: unknown): void;
  markStale(): void;
  setUsage(u: Usage): void;
}

export function applyEvent(st: DataState, event: string, data: unknown): Partial<DataState> | null {
  switch (event) {
    case 'hello':
      return { hello: data as Hello };
    case 'active_changed':
      return { sessions: (data as { sessions: Session[] }).sessions, sessionsSynced: true, stale: false };
    case 'chats_changed': {
      const d = data as { full?: Chat[]; upsert?: Chat[]; remove?: string[] };
      const chats = d.full ? Object.fromEntries(d.full.map((c) => [c.id, c])) : { ...st.chats };
      for (const c of d.upsert ?? []) chats[c.id] = c;
      for (const id of d.remove ?? []) delete chats[id];
      return { chats };
    }
    case 'projects_changed':
      return { projects: (data as { full: Project[] }).full };
    case 'system':
      return { system: data as SystemStats };
    case 'doctor_warning':
      return { doctor: data as DoctorWarning };
    case 'ports_changed':
      return { ports: (data as { ports: VmPort[] }).ports ?? [] };
    default:
      return null; // unknown events are ignored (forward compatible)
  }
}

export const useData = create<DataStore>((set) => ({
  sessions: [],
  chats: {},
  projects: [],
  system: null,
  doctor: null,
  usage: null,
  hello: null,
  stale: true,
  staleAt: null,
  sessionsSynced: false,
  ports: [],
  loadSnapshot: (s) => {
    if (!s) return;
    set({
      sessions: s.sessions ?? [],
      chats: Object.fromEntries((s.chats ?? []).map((c) => [c.id, c])),
      projects: s.projects ?? [],
      system: s.system,
      doctor: s.doctor,
      usage: s.usage,
      hello: s.hello,
      stale: true,
      staleAt: s.at,
    });
  },
  apply: (event, data) =>
    set((st) => {
      const patch = applyEvent(st, event, data);
      return patch ?? {};
    }),
  markStale: () => set({ stale: true, staleAt: Date.now(), sessionsSynced: false }),
  setUsage: (u) => set({ usage: u }),
}));

export const home = () => useData.getState().hello?.home ?? null;
