// The phone app's own state: settings, the phone key, which screen is open, toasts and dialogs. Lists from the VM
// and the connection state live in the desktop stores (renderer/stores/data.ts, conn.ts), shared as they are.
import { create } from 'zustand';
import type { MobileSettings, PhoneKey } from '@shared/mobile';

export type Screen =
  { kind: 'home' } | { kind: 'chat'; session: string; chatId: string | null } | { kind: 'settings' };

export type Tone = 'info' | 'error' | 'success';

export interface Toast {
  id: number;
  text: string;
  tone: Tone;
}

export interface ConfirmDialog {
  title: string;
  body: string;
  confirm: string;
  danger?: boolean;
  onConfirm: () => void;
}

export type Sheet = 'projects' | 'commands' | null;

interface AppStore {
  settings: MobileSettings | null;
  key: PhoneKey | null;
  screen: Screen;
  dark: boolean;
  toasts: Toast[];
  dialog: ConfirmDialog | null;
  sheet: Sheet;
  set(p: Partial<AppStore>): void;
  toast(text: string, tone?: Tone, ms?: number): void;
  dismiss(id: number): void;
}

let toastSeq = 1;

export const useApp = create<AppStore>((set, get) => ({
  settings: null,
  key: null,
  screen: { kind: 'home' },
  dark: true,
  toasts: [],
  dialog: null,
  sheet: null,
  set: (p) => set(p),
  toast: (text, tone = 'info', ms = 4000) => {
    const id = toastSeq++;
    // the same text twice in a row (a repeated tap) is one toast
    set((s) => ({ toasts: [...s.toasts.filter((x) => x.text !== text), { id, text, tone }].slice(-3) }));
    window.setTimeout(() => get().dismiss(id), ms);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/**
 * Screens are browser history entries, so Android's back button (Capacitor goes back in the WebView's history)
 * closes a chat or the settings, as in any app.
 */
export function go(screen: Screen): void {
  useApp.getState().set({ screen, sheet: null });
  if (screen.kind === 'home') history.replaceState({ screen }, '');
  else history.pushState({ screen }, '');
}

export function back(): void {
  if (history.state?.screen && history.state.screen.kind !== 'home') history.back();
  else useApp.getState().set({ screen: { kind: 'home' } });
}

export function wireHistory(): void {
  history.replaceState({ screen: { kind: 'home' } }, '');
  window.addEventListener('popstate', (e) => {
    const s = (e.state as { screen?: Screen } | null)?.screen;
    const app = useApp.getState();
    // an open sheet or dialog closes first, the screen stays
    if (app.sheet || app.dialog) {
      app.set({ sheet: null, dialog: null });
      if (s?.kind !== app.screen.kind) history.pushState({ screen: app.screen }, '');
      return;
    }
    app.set({ screen: s ?? { kind: 'home' } });
  });
}
