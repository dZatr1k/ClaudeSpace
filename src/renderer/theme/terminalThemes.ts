// xterm.js themes (DESIGN §5.2 ANSI palette, retuned only where contrast rose). Background = bg-base, foreground = text,
// cursor = accent.
import type { ITheme } from '@xterm/xterm';

export const darkTerminal: ITheme = {
  background: '#121110',
  foreground: '#EDE9E4',
  cursor: '#D97757',
  cursorAccent: '#121110',
  selectionBackground: '#3E3833',
  black: '#24211F',
  red: '#F26D5E',
  green: '#55C482',
  yellow: '#E6B84A',
  blue: '#74ABF6',
  magenta: '#CC99EC',
  cyan: '#62CBD9',
  white: '#D6D1CA',
  brightBlack: '#7A736B',
  brightRed: '#FF8F84',
  brightGreen: '#82E2A5',
  brightYellow: '#F6D06F',
  brightBlue: '#98C3FF',
  brightMagenta: '#DFB8F6',
  brightCyan: '#8EE2ED',
  brightWhite: '#FAF8F5',
};

// light: ANSI "white" is a mid grey (a white glyph on a light background is otherwise invisible)
export const lightTerminal: ITheme = {
  background: '#FBFAF8',
  foreground: '#1D1B19',
  cursor: '#B4532F',
  cursorAccent: '#FBFAF8',
  selectionBackground: '#DFD6CC',
  black: '#1D1B19',
  red: '#BF2A24',
  green: '#16773A',
  yellow: '#8F5F00',
  blue: '#1D58C8',
  magenta: '#8A3FA8',
  cyan: '#0B717A',
  white: '#7A736B',
  brightBlack: '#5F5850',
  brightRed: '#D3322C',
  brightGreen: '#1E8744',
  brightYellow: '#9E6A00',
  brightBlue: '#2C6BDB',
  brightMagenta: '#9A4DBA',
  brightCyan: '#0E808B',
  brightWhite: '#958E85',
};

export function terminalTheme(dark: boolean): ITheme {
  return dark ? darkTerminal : lightTerminal;
}

export function terminalFontFamily(primary: string): string {
  const fams = [
    primary,
    'JetBrains Mono',
    'Cascadia Mono',
    'Consolas',
    'Segoe UI Symbol',
    'Segoe UI Emoji',
    'Noto Color Emoji',
    'monospace',
  ];
  return [...new Set(fams)].map((f) => (/\s/.test(f) && f !== 'monospace' ? `"${f}"` : f)).join(', ');
}
