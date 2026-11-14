// Hotkeys (DESIGN §6). Principle: the terminal is more important than the app. Everything bash/readline, tmux and
// Claude Code use goes to the terminal; the app takes Ctrl+Shift+…, Ctrl+Tab, Ctrl+digits and F-keys.

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export type AppCommandId =
  | 'palette'
  | 'search.chats'
  | 'tab.next'
  | 'tab.prev'
  | `tab.goto.${number}`
  | 'tab.last'
  | 'chat.newHere'
  | 'chat.newDialog'
  | 'tab.close'
  | 'shell.here'
  | 'lazygit.here'
  | 'sidebar.toggle'
  | 'right.toggle'
  | 'sidebar.focus'
  | 'sidebar.projects'
  | 'sidebar.chats'
  | 'sidebar.archive'
  | 'term.find'
  | 'term.copy'
  | 'term.paste'
  | 'font.bigger'
  | 'font.smaller'
  | 'font.reset'
  | 'settings'
  | 'system.usage'
  | 'rdp'
  | 'pane.next'
  | 'pane.prev'
  | 'resync'
  | 'fullscreen'
  | 'devtools';

function codeDigit(e: KeyLike): number | null {
  const m = /^Digit([0-9])$/.exec(e.code ?? '');
  if (m) return Number(m[1]);
  return /^[0-9]$/.test(e.key) ? Number(e.key) : null;
}

/** Letter by physical key (works with the Russian layout too). */
function letter(e: KeyLike): string {
  const m = /^Key([A-Z])$/.exec(e.code ?? '');
  return m ? (m[1] as string) : e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

/**
 * App command for a keydown, or null if the key belongs to the terminal / focused element.
 * inTerminal: focus is inside xterm. dev: F12 allowed.
 */
export function appShortcut(e: KeyLike, inTerminal: boolean, dev = false): AppCommandId | null {
  if (e.metaKey) return null;
  const ctrl = e.ctrlKey;
  const shift = e.shiftKey;
  const alt = e.altKey;
  const L = letter(e);
  const d = codeDigit(e);

  if (!ctrl && !alt && !shift) {
    if (e.key === 'F1') return 'palette';
    if (e.key === 'F5') return 'resync';
    if (e.key === 'F11') return 'fullscreen';
    if (e.key === 'F12' && dev) return 'devtools';
    return null;
  }
  if (ctrl && alt && !shift && L === 'R') return 'rdp';
  // split view: the next / previous pane
  if (ctrl && alt && !shift && e.key === 'ArrowRight') return 'pane.next';
  if (ctrl && alt && !shift && e.key === 'ArrowLeft') return 'pane.prev';
  if (alt) return null; // Alt+arrows etc. belong to tmux
  // Shift without Ctrl is typing: capitals and symbols (on the Russian layout "," is Shift+/, "№" is Shift+3…).
  // Never treat it as a shortcut — everything below requires Ctrl.
  if (!ctrl) return null;
  if (e.key === 'Tab') return shift ? 'tab.prev' : 'tab.next';
  if (ctrl && !shift && e.key === 'PageDown') return 'tab.next';
  if (ctrl && !shift && e.key === 'PageUp') return 'tab.prev';
  if (ctrl && shift) {
    if (d !== null && d >= 1 && d <= 3)
      return (['sidebar.projects', 'sidebar.chats', 'sidebar.archive'] as const)[d - 1] as AppCommandId;
    switch (L) {
      case 'P':
        return 'palette';
      case 'N':
        return 'chat.newHere';
      case 'T':
        return 'chat.newDialog';
      case 'W':
        return 'tab.close';
      case 'S':
        return 'shell.here';
      case 'G':
        return 'lazygit.here';
      case 'B':
        return 'sidebar.toggle';
      case 'J':
        return 'right.toggle';
      case 'E':
        return 'sidebar.focus';
      case 'F':
        return 'term.find';
      case 'C':
        return 'term.copy';
      case 'V':
        return 'term.paste';
      case 'U':
        return 'system.usage';
      case 'H':
        return 'search.chats';
    }
    return null;
  }
  // Ctrl without Shift
  if (d !== null && d >= 1 && d <= 9) return d === 9 ? 'tab.last' : (`tab.goto.${d}` as AppCommandId);
  if (e.key === '=' || e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd') return 'font.bigger';
  if (e.key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract') return 'font.smaller';
  if (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0') return 'font.reset';
  if (e.key === ',' || e.code === 'Comma') return 'settings';
  // Ctrl+K: palette only outside the terminal (in the terminal it is kill-line)
  if (L === 'K' && !inTerminal) return 'palette';
  return null;
}

export type TermKeyAction = 'copy-or-sigint' | 'paste' | 'newline' | null;

/** Special terminal keys handled by the app before xterm (smart Ctrl+C/V, Shift+Enter, Shift+Insert). */
export function terminalKey(e: KeyLike, opts: { ctrlCCopies: boolean; ctrlVPastes: boolean }): TermKeyAction {
  if (e.metaKey || e.altKey) return null;
  const L = letter(e);
  if (e.ctrlKey && !e.shiftKey && L === 'C' && opts.ctrlCCopies) return 'copy-or-sigint';
  if (e.ctrlKey && !e.shiftKey && L === 'V' && opts.ctrlVPastes) return 'paste';
  if (!e.ctrlKey && e.shiftKey && e.key === 'Enter') return 'newline';
  if (!e.ctrlKey && e.shiftKey && e.key === 'Insert') return 'paste';
  return null;
}

export const HOTKEY_LABELS: Partial<Record<AppCommandId, string>> = {
  palette: 'Ctrl+Shift+P',
  'search.chats': 'Ctrl+Shift+H',
  'tab.next': 'Ctrl+Tab',
  'pane.next': 'Ctrl+Alt+→',
  'pane.prev': 'Ctrl+Alt+←',
  'tab.prev': 'Ctrl+Shift+Tab',
  'chat.newHere': 'Ctrl+Shift+N',
  'chat.newDialog': 'Ctrl+Shift+T',
  'tab.close': 'Ctrl+Shift+W',
  'shell.here': 'Ctrl+Shift+S',
  'lazygit.here': 'Ctrl+Shift+G',
  'sidebar.toggle': 'Ctrl+Shift+B',
  'right.toggle': 'Ctrl+Shift+J',
  'sidebar.focus': 'Ctrl+Shift+E',
  'term.find': 'Ctrl+Shift+F',
  settings: 'Ctrl+,',
  'system.usage': 'Ctrl+Shift+U',
  rdp: 'Ctrl+Alt+R',
  resync: 'F5',
  fullscreen: 'F11',
  'font.bigger': 'Ctrl+=',
  'font.smaller': 'Ctrl+-',
  'font.reset': 'Ctrl+0',
};
