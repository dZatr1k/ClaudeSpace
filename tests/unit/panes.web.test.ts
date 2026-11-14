// Split view: panes, the focused pane and the active tab stay consistent through layout changes, clicks and closes.
import { describe, expect, it } from 'vitest';
import type { PaneState } from '../../src/renderer/lib/panes';
import { cyclePane, focusPane, paneRect, place, reconcile, setSplit } from '../../src/renderer/lib/panes';

const single = (activeId: string | null): PaneState => ({
  split: 'single',
  panes: [activeId],
  focus: 0,
  activeId,
});
const TABS = ['a', 'b', 'c', 'd', 'e'];

describe('split view panes', () => {
  it('switching layout keeps the active tab first and fills the rest in tab order', () => {
    const s = setSplit(single('c'), 'grid', TABS);
    expect(s.panes).toEqual(['c', 'a', 'b', 'd']);
    expect([s.focus, s.activeId]).toEqual([0, 'c']);
    const two = setSplit({ ...s, activeId: 'd', focus: 3 }, 'cols', TABS);
    expect(two.panes).toEqual(['d', 'c']);
    expect(setSplit(single('a'), 'cols', ['a']).panes).toEqual(['a', null]);
    expect(setSplit(two, 'single', TABS)).toMatchObject({ panes: ['d'], activeId: 'd' });
  });

  it('a tab on screen gets the focus; another one replaces the focused pane', () => {
    let s = setSplit(single('a'), 'cols', TABS); // [a, b]
    s = place(s, 'b');
    expect([s.focus, s.panes]).toEqual([1, ['a', 'b']]);
    s = place(s, 'e');
    expect(s.panes).toEqual(['a', 'e']);
    expect(s.activeId).toBe('e');
  });

  it('empty panes can be focused; closing refills them with tabs not on screen', () => {
    let s = setSplit(single('a'), 'grid', ['a', 'b']); // [a, b, null, null]
    s = focusPane(s, 3);
    expect([s.focus, s.activeId]).toEqual([3, null]);
    s = place(s, 'b'); // already on screen: focus moves there
    expect(s.focus).toBe(1);
    s = reconcile({ ...setSplit(single('a'), 'cols', TABS) }, ['b', 'c'], 'b'); // a closed
    expect(s.panes).toEqual(['c', 'b']);
    expect(s.activeId).toBe('c');
  });

  it('cycles panes and lays them out', () => {
    const s = setSplit(single('a'), 'rows', TABS);
    expect(cyclePane(s, 1).activeId).toBe('b');
    expect(cyclePane(s, -1).activeId).toBe('b');
    expect(paneRect('grid', 3)).toEqual({ left: 50, top: 50, width: 50, height: 50 });
    expect(paneRect('rows', 1)).toEqual({ left: 0, top: 50, width: 100, height: 50 });
  });
});
