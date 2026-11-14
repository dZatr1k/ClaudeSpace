// Full-text search through chat transcripts, done by the agent on the VM (stage 6). One search at a time: a new one
// supersedes the previous (the agent cancels it), results stream in as events.
import { agent, on } from '../bridge';
import { applySearchEvent, emptySearch, useSearch } from '../stores/search';
import { useConn } from '../stores/conn';

let n = 0;
export const MIN_QUERY = 2;

export async function runSearch(query: string): Promise<void> {
  const q = query.trim();
  const st = useSearch.getState();
  if (q.length < MIN_QUERY) {
    if (st.running && st.id) void agent('search_cancel', { searchId: st.id }).catch(() => undefined);
    st.set({ ...emptySearch, query });
    return;
  }
  const id = `s${Date.now().toString(36)}${(n++).toString(36)}`;
  st.set({ ...emptySearch, id, query, running: true });
  try {
    await agent('search_chats', { searchId: id, query: q });
  } catch (e) {
    if (useSearch.getState().id === id)
      useSearch.getState().set({ running: false, error: (e as Error).message || String(e) });
  }
}

export function cancelSearch(): void {
  const st = useSearch.getState();
  if (st.running && st.id) void agent('search_cancel', { searchId: st.id }).catch(() => undefined);
  st.set({ running: false });
}

export function wireSearch(): void {
  on('agent.event', ({ event, data }) => {
    if (event !== 'search_hits' && event !== 'search_done') return;
    const st = useSearch.getState();
    const next = applySearchEvent(st, event, data);
    if (next !== st) st.set(next);
  });
  useConn.subscribe((c, p) => {
    if (c.state.kind !== 'online' && p.state.kind === 'online' && useSearch.getState().running)
      useSearch.getState().set({ running: false, error: 'нет связи с VM' });
  });
}
