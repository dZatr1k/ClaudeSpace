// Several terminals on screen (split view): the pane layouts and the rules that keep panes, the focused pane and
// the active tab consistent. Pure, so the store stays small and this is unit-tested.
export type SplitMode = 'single' | 'cols' | 'rows' | 'grid';
export const SPLIT_MODES: SplitMode[] = ['single', 'cols', 'rows', 'grid'];

export interface PaneState {
  split: SplitMode;
  /** tab id per pane (null = empty pane); in 'single' mode: [activeId] */
  panes: (string | null)[];
  /** index of the focused pane: its tab is the active one */
  focus: number;
  activeId: string | null;
}

export const paneCount = (m: SplitMode): number => (m === 'single' ? 1 : m === 'grid' ? 4 : 2);

/** position of pane i in percent of the terminal area */
export function paneRect(
  m: SplitMode,
  i: number,
): { left: number; top: number; width: number; height: number } {
  if (m === 'cols') return { left: i * 50, top: 0, width: 50, height: 100 };
  if (m === 'rows') return { left: 0, top: i * 50, width: 100, height: 50 };
  if (m === 'grid') return { left: (i % 2) * 50, top: Math.floor(i / 2) * 50, width: 50, height: 50 };
  return { left: 0, top: 0, width: 100, height: 100 };
}

function fill(panes: (string | null)[], tabIds: string[]): (string | null)[] {
  const out = [...panes];
  const spare = tabIds.filter((id) => !out.includes(id));
  for (let i = 0; i < out.length; i++) if (out[i] === null && spare.length) out[i] = spare.shift() as string;
  return out;
}

/** switch layout: the active tab goes first, then the tabs already on screen, then the rest in tab order */
export function setSplit(s: PaneState, split: SplitMode, tabIds: string[]): PaneState {
  const n = paneCount(split);
  const order = [s.activeId, ...s.panes, ...tabIds].filter(
    (id, i, a): id is string => !!id && tabIds.includes(id) && a.indexOf(id) === i,
  );
  const panes: (string | null)[] = Array.from({ length: n }, (_, i) => order[i] ?? null);
  return { split, panes, focus: 0, activeId: panes[0] ?? null };
}

/** a tab becomes active: focus its pane if it is on screen, else it replaces the focused pane's tab */
export function place(s: PaneState, id: string | null): PaneState {
  if (s.split === 'single') return { ...s, panes: [id], focus: 0, activeId: id };
  if (id === null) return { ...s, activeId: null };
  const at = s.panes.indexOf(id);
  if (at >= 0) return { ...s, focus: at, activeId: id };
  const panes = [...s.panes];
  panes[s.focus] = id;
  return { ...s, panes, activeId: id };
}

/** click on a pane (also an empty one) */
export function focusPane(s: PaneState, i: number): PaneState {
  if (i < 0 || i >= s.panes.length) return s;
  return { ...s, focus: i, activeId: s.panes[i] ?? null };
}

/** after tabs were closed: drop gone ids, refill empty panes with tabs not on screen, keep the focus */
export function reconcile(s: PaneState, tabIds: string[], fallbackActive: string | null): PaneState {
  if (s.split === 'single') return { ...s, panes: [fallbackActive], focus: 0, activeId: fallbackActive };
  const panes = fill(
    s.panes.map((id) => (id && tabIds.includes(id) ? id : null)),
    tabIds,
  );
  const focus = Math.min(s.focus, panes.length - 1);
  return { ...s, panes, focus, activeId: panes[focus] ?? null };
}

/** next / previous pane (wraps) */
export function cyclePane(s: PaneState, dir: 1 | -1): PaneState {
  const n = s.panes.length;
  return n <= 1 ? s : focusPane(s, (s.focus + dir + n) % n);
}
