// The key row above the phone keyboard (docs/MOBILE.md): what each key sends, Ctrl as a one-shot modifier, and text
// from the input field sent whole as a bracketed paste. Pure functions, tested in tests/unit/mobileKeys.web.test.ts.

export type KeyId = 'esc' | 'tab' | 'stab' | 'ctrl' | 'left' | 'up' | 'down' | 'right' | 'enter';

export interface TermKey {
  id: KeyId;
  label: string;
  /** accessible name */
  name: string;
}

export const KEY_ROW: readonly TermKey[] = [
  { id: 'esc', label: 'Esc', name: 'Esc' },
  { id: 'tab', label: 'Tab', name: 'Tab' },
  { id: 'stab', label: '⇧Tab', name: 'Shift+Tab' },
  { id: 'ctrl', label: 'Ctrl', name: 'Ctrl' },
  { id: 'left', label: '←', name: 'Стрелка влево' },
  { id: 'up', label: '↑', name: 'Стрелка вверх' },
  { id: 'down', label: '↓', name: 'Стрелка вниз' },
  { id: 'right', label: '→', name: 'Стрелка вправо' },
  { id: 'enter', label: '⏎', name: 'Enter' },
];

const ARROW: Partial<Record<KeyId, string>> = { up: 'A', down: 'B', right: 'C', left: 'D' };

/** Bytes for a key. Arrows follow the terminal's cursor key mode (DECCKM), as a hardware keyboard would. */
export function keySeq(id: KeyId, appCursor: boolean): string {
  const dir = ARROW[id];
  if (dir) return (appCursor ? '\x1bO' : '\x1b[') + dir;
  switch (id) {
    case 'esc':
      return '\x1b';
    case 'tab':
      return '\t';
    case 'stab':
      return '\x1b[Z';
    case 'enter':
      return '\r';
    default:
      return '';
  }
}

// a Russian layout letter means the key under it: Ctrl+с is Ctrl+C
const RU = 'йцукенгшщзхъфывапролджэячсмитьбю';
const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.";

/** The control character for Ctrl+key, or null when Ctrl does nothing with this key. */
export function ctrlChar(ch: string): string | null {
  if (ch.length !== 1) return null;
  let c = ch.toLowerCase();
  const i = RU.indexOf(c);
  if (i >= 0) c = EN[i] as string;
  if (c >= 'a' && c <= 'z') return String.fromCharCode(c.charCodeAt(0) - 96);
  switch (c) {
    case '@':
    case ' ':
    case '2':
      return '\x00';
    case '[':
    case '3':
      return '\x1b';
    case '\\':
    case '4':
      return '\x1c';
    case ']':
    case '5':
      return '\x1d';
    case '^':
    case '6':
      return '\x1e';
    case '_':
    case '-':
    case '7':
      return '\x1f';
    case '?':
    case '8':
      return '\x7f';
    default:
      return null;
  }
}

/**
 * Text from the input field as the terminal should get it: line breaks as Enter presses would be (CR), wrapped in
 * bracketed paste when the program asked for it, so a multi-line message stays one message in Claude Code.
 */
export function pasteSeq(text: string, bracketed: boolean): string {
  const body = text.replace(/\r?\n/g, '\r');
  if (!bracketed) return body;
  // a paste-end marker inside the text would end the paste early
  return '\x1b[200~' + body.split('\x1b[200~').join('').split('\x1b[201~').join('') + '\x1b[201~';
}
