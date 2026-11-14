import { describe, expect, it } from 'vitest';
import { appShortcut, terminalKey } from '../../src/renderer/keymap';
import type { KeyLike } from '../../src/renderer/keymap';

const k = (key: string, mods: Partial<KeyLike> = {}, code?: string): KeyLike => ({
  key,
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe('appShortcut', () => {
  it('app keys work in the terminal', () => {
    expect(appShortcut(k('P', { ctrlKey: true, shiftKey: true }, 'KeyP'), true)).toBe('palette');
    expect(appShortcut(k('Tab', { ctrlKey: true }), true)).toBe('tab.next');
    expect(appShortcut(k('Tab', { ctrlKey: true, shiftKey: true }), true)).toBe('tab.prev');
    expect(appShortcut(k('3', { ctrlKey: true }, 'Digit3'), true)).toBe('tab.goto.3');
    expect(appShortcut(k('9', { ctrlKey: true }, 'Digit9'), true)).toBe('tab.last');
    expect(appShortcut(k('W', { ctrlKey: true, shiftKey: true }, 'KeyW'), true)).toBe('tab.close');
    expect(appShortcut(k('!', { ctrlKey: true, shiftKey: true }, 'Digit1'), false)).toBe('sidebar.projects');
    expect(appShortcut(k('r', { ctrlKey: true, altKey: true }, 'KeyR'), true)).toBe('rdp');
    expect(appShortcut(k('F5'), true)).toBe('resync');
    expect(appShortcut(k('0', { ctrlKey: true }, 'Digit0'), true)).toBe('font.reset');
  });
  it('terminal keys stay in the terminal', () => {
    for (const key of ['w', 't', 'r', 'l', 'o', 'b', 'c', 'v', 'd']) {
      expect(appShortcut(k(key, { ctrlKey: true }, `Key${key.toUpperCase()}`), true)).toBeNull();
    }
    expect(appShortcut(k('Escape'), true)).toBeNull();
    expect(appShortcut(k('Tab', { shiftKey: true }), true)).toBeNull();
    expect(appShortcut(k('ArrowLeft', { altKey: true }), true)).toBeNull();
  });
  it('Ctrl+K: palette only outside the terminal', () => {
    expect(appShortcut(k('k', { ctrlKey: true }, 'KeyK'), true)).toBeNull();
    expect(appShortcut(k('k', { ctrlKey: true }, 'KeyK'), false)).toBe('palette');
  });
  it('works with the Russian layout (by physical key)', () => {
    expect(appShortcut(k('З', { ctrlKey: true, shiftKey: true }, 'KeyP'), true)).toBe('palette');
    expect(appShortcut(k('л', { ctrlKey: true }, 'KeyK'), false)).toBe('palette');
  });
  it('Shift alone is typing, never a shortcut (capitals and symbols, both layouts)', () => {
    const shifted: [string, string][] = [
      [',', 'Slash'], // RU: comma is Shift+/
      ['№', 'Digit3'],
      [';', 'Digit4'],
      ['%', 'Digit5'],
      [':', 'Digit6'],
      ['?', 'Digit7'],
      ['*', 'Digit8'],
      ['(', 'Digit9'],
      [')', 'Digit0'],
      ['!', 'Digit1'],
      ['"', 'Digit2'],
      ['_', 'Minus'],
      ['+', 'Equal'],
      ['<', 'Comma'], // EN: Shift+,
      ['Ж', 'Semicolon'],
      ['A', 'KeyA'],
      ['Б', 'Comma'],
    ];
    for (const [key, code] of shifted) {
      for (const inTerm of [true, false]) {
        expect(appShortcut(k(key, { shiftKey: true }, code), inTerm), `${key} ${code}`).toBeNull();
      }
    }
  });
  it('Ctrl shortcuts still work after the Shift fix', () => {
    expect(appShortcut(k('=', { ctrlKey: true }, 'Equal'), true)).toBe('font.bigger');
    expect(appShortcut(k('-', { ctrlKey: true }, 'Minus'), true)).toBe('font.smaller');
    expect(appShortcut(k(',', { ctrlKey: true }, 'Comma'), true)).toBe('settings');
    expect(appShortcut(k('б', { ctrlKey: true }, 'Comma'), true)).toBe('settings'); // RU layout, same physical key
  });
  it('F12 only in dev', () => {
    expect(appShortcut(k('F12'), false)).toBeNull();
    expect(appShortcut(k('F12'), false, true)).toBe('devtools');
  });
});

describe('terminalKey', () => {
  const o = { ctrlCCopies: true, ctrlVPastes: true };
  it('smart copy/paste, Shift+Enter, Shift+Insert', () => {
    expect(terminalKey(k('c', { ctrlKey: true }, 'KeyC'), o)).toBe('copy-or-sigint');
    expect(terminalKey(k('v', { ctrlKey: true }, 'KeyV'), o)).toBe('paste');
    expect(terminalKey(k('Enter', { shiftKey: true }), o)).toBe('newline');
    expect(terminalKey(k('Insert', { shiftKey: true }), o)).toBe('paste');
    expect(terminalKey(k('Enter'), o)).toBeNull();
  });
  it('respects settings', () => {
    const off = { ctrlCCopies: false, ctrlVPastes: false };
    expect(terminalKey(k('c', { ctrlKey: true }, 'KeyC'), off)).toBeNull();
    expect(terminalKey(k('v', { ctrlKey: true }, 'KeyV'), off)).toBeNull();
  });
});
