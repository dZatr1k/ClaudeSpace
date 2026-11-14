// xterm.js themes (DESIGN §5.2 ANSI palette). Background = bg-base, foreground = text, cursor = accent.
import type { ITheme } from '@xterm/xterm';

export const darkTerminal: ITheme = {
  background: '#0F1115',
  foreground: '#E6E8EB',
  cursor: '#D97757',
  cursorAccent: '#0F1115',
  selectionBackground: '#3A4250',
  black: '#1C2027',
  red: '#F0645A',
  green: '#4FBF7A',
  yellow: '#E3B341',
  blue: '#6CA6F5',
  magenta: '#C792EA',
  cyan: '#5CC8D7',
  white: '#C9CED6',
  brightBlack: '#4A525E',
  brightRed: '#FF8A80',
  brightGreen: '#7EE0A1',
  brightYellow: '#F5CE6B',
  brightBlue: '#94C0FF',
  brightMagenta: '#DDB4F5',
  brightCyan: '#8AE0EC',
  brightWhite: '#F4F5F7',
};

export const lightTerminal: ITheme = {
  background: '#FBFBFC',
  foreground: '#1A1D21',
  cursor: '#C15F3C',
  cursorAccent: '#FBFBFC',
  selectionBackground: '#C9D7EA',
  black: '#1A1D21',
  red: '#C62828',
  green: '#1B7F3B',
  yellow: '#9A6700',
  blue: '#1F5FD1',
  magenta: '#8E44AD',
  cyan: '#0E7C86',
  white: '#D5D9DF',
  brightBlack: '#5A6270',
  brightRed: '#E53935',
  brightGreen: '#2E9E52',
  brightYellow: '#B7791F',
  brightBlue: '#3B7BEA',
  brightMagenta: '#A55BC4',
  brightCyan: '#1597A3',
  brightWhite: '#F3F4F6',
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
