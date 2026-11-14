import { create } from 'zustand';
import type { SearchDone, SearchHit } from '@shared/protocol';

/** full-text search through chat transcripts (stage 6), filled by the agent's search_hits / search_done events */
export interface SearchState {
  id: string | null;
  query: string;
  hits: SearchHit[];
  done: SearchDone | null;
  error: string | null;
  running: boolean;
}

export const emptySearch: SearchState = {
  id: null,
  query: '',
  hits: [],
  done: null,
  error: null,
  running: false,
};

/** pure: apply an agent event to the search state (events of an older search are ignored) */
export function applySearchEvent(st: SearchState, event: string, data: unknown): SearchState {
  if (event === 'search_hits') {
    const d = data as { searchId: string; hits: SearchHit[] };
    if (d.searchId !== st.id) return st;
    const seen = new Set(st.hits.map((h) => h.chatId));
    const fresh = d.hits.filter((h) => !seen.has(h.chatId));
    return fresh.length ? { ...st, hits: [...st.hits, ...fresh] } : st;
  }
  if (event === 'search_done') {
    const d = data as SearchDone;
    if (d.searchId !== st.id) return st;
    return { ...st, done: d, running: false };
  }
  return st;
}

export const useSearch = create<SearchState & { set(p: Partial<SearchState>): void }>((set) => ({
  ...emptySearch,
  set: (p) => set(p),
}));
