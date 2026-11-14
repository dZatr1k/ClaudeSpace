// Stage 6: full-text chat search state — streamed hits of the current search only, dedupe, done; Ctrl+Shift+H.
import { describe, expect, it } from 'vitest';
import type { SearchHit } from '@shared/protocol';
import { applySearchEvent, emptySearch } from '../../src/renderer/stores/search';
import type { SearchState } from '../../src/renderer/stores/search';
import { appShortcut } from '../../src/renderer/keymap';

const hit = (chatId: string): SearchHit => ({
  chatId,
  title: chatId,
  project: '/p',
  lastAt: 1,
  archived: false,
  count: 1,
  matches: [{ role: 'user', text: 'abc', match: [0, 1], at: null }],
});
const done = (searchId: string) => ({
  searchId,
  scanned: 3,
  total: 3,
  found: 2,
  truncated: false,
  timedOut: false,
  cancelled: false,
  ms: 5,
});

describe('chat search state', () => {
  it('appends hits of the current search, ignores others, finishes on done', () => {
    let st: SearchState = { ...emptySearch, id: 's1', query: 'abc', running: true };
    st = applySearchEvent(st, 'search_hits', { searchId: 's1', hits: [hit('a')] });
    st = applySearchEvent(st, 'search_hits', { searchId: 's0', hits: [hit('x')] });
    st = applySearchEvent(st, 'search_hits', { searchId: 's1', hits: [hit('a'), hit('b')] });
    expect(st.hits.map((h) => h.chatId)).toEqual(['a', 'b']);
    const same = applySearchEvent(st, 'search_done', done('s0'));
    expect(same).toBe(st);
    st = applySearchEvent(st, 'search_done', done('s1'));
    expect(st.running).toBe(false);
    expect(st.done?.found).toBe(2);
    expect(applySearchEvent(st, 'turn_done', {})).toBe(st);
  });

  it('Ctrl+Shift+H opens the search, also outside a Latin layout', () => {
    const k = { key: 'Р', code: 'KeyH', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
    expect(appShortcut(k, true)).toBe('search.chats');
    expect(appShortcut({ ...k, shiftKey: false }, true)).toBeNull();
  });
});
