import { create } from 'zustand';
import type { Tab } from '@shared/model';

interface TabsStore {
  tabs: Tab[];
  activeId: string | null;
  add(tab: Tab, activate?: boolean): void;
  update(id: string, patch: Partial<Tab>): void;
  remove(id: string): void;
  activate(id: string | null): void;
  move(from: number, to: number): void;
  setAll(tabs: Tab[], activeId: string | null): void;
}

export const useTabs = create<TabsStore>((set) => ({
  tabs: [],
  activeId: null,
  add: (tab, activate = true) =>
    set((s) => ({ tabs: [...s.tabs, tab], activeId: activate ? tab.id : (s.activeId ?? tab.id) })),
  update: (id, patch) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  remove: (id) =>
    set((s) => {
      const i = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeId = s.activeId;
      if (activeId === id) activeId = tabs[Math.min(i, tabs.length - 1)]?.id ?? null;
      return { tabs, activeId };
    }),
  activate: (id) => set({ activeId: id }),
  move: (from, to) =>
    set((s) => {
      const tabs = [...s.tabs];
      const [t] = tabs.splice(from, 1);
      if (t) tabs.splice(to, 0, t);
      return { tabs };
    }),
  setAll: (tabs, activeId) => set({ tabs, activeId }),
}));

export const activeTab = (): Tab | null => {
  const s = useTabs.getState();
  return s.tabs.find((t) => t.id === s.activeId) ?? null;
};

export function nextTabId(dir: 1 | -1): string | null {
  const { tabs, activeId } = useTabs.getState();
  if (!tabs.length) return null;
  const i = tabs.findIndex((t) => t.id === activeId);
  return tabs[(i + dir + tabs.length) % tabs.length]?.id ?? null;
}
