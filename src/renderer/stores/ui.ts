import { create } from 'zustand';
import type { Selection, WorkspaceLayout } from '@shared/model';
import type { Settings } from '@shared/settings';
import type { AppInfo } from '@shared/ipc';

export type SystemSection = 'usage' | 'doctor' | 'resources';
export type ClaudeSection = 'instructions' | 'memory' | 'mcp' | 'skills' | 'plugins' | 'hooks';
export type SettingsSection =
  | 'connection'
  | 'pclink'
  | 'sudo'
  | 'appearance'
  | 'terminal'
  | 'notifications'
  | 'startup'
  | 'integrations'
  | 'about';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
  action?: { label: string; run: () => void };
  ttl: number;
}

export type Dialog =
  | { kind: 'confirm'; title: string; body?: string; danger?: string; confirm: string; onConfirm: () => void }
  | {
      kind: 'prompt';
      title: string;
      hint?: string;
      value: string;
      placeholder?: string;
      confirm: string;
      onSubmit: (v: string) => void;
    }
  | { kind: 'info'; title: string; body?: string }
  | { kind: 'newChat' }
  | { kind: 'createProject'; path?: string }
  | { kind: 'newTask'; repo: string }
  | { kind: 'clone' }
  | { kind: 'paste'; text: string; onConfirm: () => void };

/** the file / diff viewer over the window (stage 5) */
export type Viewer =
  | { kind: 'file'; path: string }
  | { kind: 'diff'; root: string; file: string; staged: boolean; untracked: boolean }
  | { kind: 'commit'; root: string; hash: string; subject: string };

interface UiStore {
  selection: Selection;
  layout: WorkspaceLayout;
  filter: string;
  projectFilter: string | null;
  expanded: Record<string, boolean>;
  activeExpanded: boolean;
  activeCollapsed: boolean;
  palette: boolean;
  /** full-text chat search overlay: the initial query, null = closed */
  chatSearch: string | null;
  system: SystemSection | null;
  /** the «Claude» screen: section and the folder project-level files are looked up from (null = user only) */
  claudeScreen: { section: ClaudeSection; folder: string | null } | null;
  settingsOpen: SettingsSection | null;
  dialog: Dialog | null;
  viewer: Viewer | null;
  toasts: Toast[];
  settings: Settings | null;
  appInfo: AppInfo | null;
  dark: boolean;
  fontDelta: number;
  setSelection(s: Selection): void;
  setLayout(p: Partial<WorkspaceLayout>): void;
  set(p: Partial<UiStore>): void;
  toast(text: string, kind?: Toast['kind'], action?: Toast['action'], ttl?: number): void;
  dismissToast(id: number): void;
}

let toastId = 1;

export const defaultLayout: WorkspaceLayout = {
  sidebarWidth: 280,
  sidebarOpen: true,
  rightWidth: 360,
  rightOpen: true,
  rightTab: 'info',
  sidebarTab: 'projects',
};

export const useUi = create<UiStore>((set) => ({
  selection: null,
  layout: { ...defaultLayout },
  filter: '',
  projectFilter: null,
  expanded: {},
  activeExpanded: false,
  activeCollapsed: false,
  palette: false,
  chatSearch: null,
  system: null,
  claudeScreen: null,
  settingsOpen: null,
  dialog: null,
  viewer: null,
  toasts: [],
  settings: null,
  appInfo: null,
  dark: true,
  fontDelta: 0,
  setSelection: (selection) => set({ selection }),
  setLayout: (p) => set((s) => ({ layout: { ...s.layout, ...p } })),
  set: (p) => set(p),
  toast: (text, kind = 'info', action, ttl = 4000) =>
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id: toastId++, text, kind, action, ttl }] })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
