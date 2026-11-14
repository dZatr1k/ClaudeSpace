import { create } from 'zustand';
import type { Tab } from '@shared/model';
import type { PaneState, SplitMode } from '../lib/panes';
import { cyclePane, focusPane, place, reconcile, setSplit } from '../lib/panes';

interface TabsStore extends PaneState {
  tabs: Tab[];
  add(tab: Tab, activate?: boolean): void;
  update(id: string, patch: Partial<Tab>): void;
  remove(id: string): void;
  activate(id: string | null): void;
  move(from: number, to: number): void;
  setAll(tabs: Tab[], activeId: string | null): void;
  /** split view (lib/panes.ts): layout, click on a pane, next/previous pane, restore from the workspace */
  setSplit(split: SplitMode): void;
  focusPane(i: number): void;
  cyclePane(dir: 1 | -1): void;
  restorePanes(split: SplitMode, panes: (string | null)[]): void;
}

const pane = (s: TabsStore): PaneState => ({
  split: s.split,
  panes: s.panes,
  focus: s.focus,
  activeId: s.activeId,
});
const ids = (tabs: Tab[]) => tabs.map((t) => t.id);

export const useTabs = create<TabsStore>((set) => ({
  tabs: [],
  activeId: null,
  split: 'single',
  panes: [null],
  focus: 0,
  add: (tab, activate = true) =>
    set((s) => {
      const tabs = [...s.tabs, tab];
      if (activate || !s.activeId) return { tabs, ...place(pane(s), tab.id) };
      return { tabs, ...reconcile(pane(s), ids(tabs), s.activeId) }; // an empty pane takes it
    }),
  update: (id, patch) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  remove: (id) =>
    set((s) => {
      const i = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeId = s.activeId;
      if (activeId === id) activeId = tabs[Math.min(i, tabs.length - 1)]?.id ?? null;
      return { tabs, ...reconcile(pane(s), ids(tabs), activeId) };
    }),
  activate: (id) => set((s) => place(pane(s), id)),
  move: (from, to) =>
    set((s) => {
      const tabs = [...s.tabs];
      const [t] = tabs.splice(from, 1);
      if (t) tabs.splice(to, 0, t);
      return { tabs };
    }),
  setAll: (tabs, activeId) => set({ tabs, activeId, split: 'single', panes: [activeId], focus: 0 }),
  setSplit: (split) => set((s) => setSplit(pane(s), split, ids(s.tabs))),
  focusPane: (i) => set((s) => focusPane(pane(s), i)),
  cyclePane: (dir) => set((s) => cyclePane(pane(s), dir)),
  restorePanes: (split, panes) =>
    set((s) => {
      const base = setSplit(pane(s), split, ids(s.tabs));
      if (split === 'single') return base;
      const known = panes.map((id) => (id && s.tabs.some((t) => t.id === id) ? id : null));
      const merged = reconcile(
        { ...base, panes: base.panes.map((_, i) => known[i] ?? null) },
        ids(s.tabs),
        s.activeId,
      );
      const at = s.activeId ? merged.panes.indexOf(s.activeId) : -1;
      return at >= 0 ? { ...merged, focus: at, activeId: s.activeId } : merged;
    }),
}));

export const activeTab = (): Tab | null => {
  const s = useTabs.getState();
  return s.tabs.find((t) => t.id === s.activeId) ?? null;
};

/** tabs on screen: the active one, or every pane's tab in split view */
export function visibleTabIds(): string[] {
  const s = useTabs.getState();
  return s.split === 'single' ? (s.activeId ? [s.activeId] : []) : s.panes.filter((x): x is string => !!x);
}

export function nextTabId(dir: 1 | -1): string | null {
  const { tabs, activeId } = useTabs.getState();
  if (!tabs.length) return null;
  const i = tabs.findIndex((t) => t.id === activeId);
  return tabs[(i + dir + tabs.length) % tabs.length]?.id ?? null;
}
