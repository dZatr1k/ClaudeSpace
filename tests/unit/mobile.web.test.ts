// The phone app's pure logic: what the key row sends, Ctrl as a one-shot modifier (with the Russian layout), the
// input field's text as a bracketed paste, settings the core accepts, and the bytes codec of the dev bridge.
import { describe, expect, it } from 'vitest';
import { KEY_ROW, ctrlChar, keySeq, menuOptions, pasteSeq } from '../../src/mobile/keys';
import { defaultMobileSettings, mergeMobileSettings } from '../../src/shared/mobile';
import { fromBase64, toBase64 } from '../../src/shared/mobileWire';

describe('key row', () => {
  it('sends what a hardware keyboard would', () => {
    expect(keySeq('esc', false)).toBe('\x1b');
    expect(keySeq('tab', false)).toBe('\t');
    expect(keySeq('stab', false)).toBe('\x1b[Z');
    expect(keySeq('enter', false)).toBe('\r');
    expect(keySeq('ctrl', false)).toBe('');
  });
  it('arrows follow the cursor key mode (DECCKM)', () => {
    expect(keySeq('up', false)).toBe('\x1b[A');
    expect(keySeq('down', true)).toBe('\x1bOB');
    expect(keySeq('right', false)).toBe('\x1b[C');
    expect(keySeq('left', true)).toBe('\x1bOD');
  });
  it('every key has a name for screen readers', () => {
    for (const k of KEY_ROW) expect(k.name.length).toBeGreaterThan(1);
  });
});

describe('ctrlChar', () => {
  it('letters and the usual symbols', () => {
    expect(ctrlChar('c')).toBe('\x03');
    expect(ctrlChar('C')).toBe('\x03');
    expect(ctrlChar('d')).toBe('\x04');
    expect(ctrlChar('[')).toBe('\x1b');
    expect(ctrlChar(' ')).toBe('\x00');
    expect(ctrlChar('?')).toBe('\x7f');
  });
  it('a Russian letter means the key under it', () => {
    expect(ctrlChar('с')).toBe('\x03'); // Ctrl+C
    expect(ctrlChar('В')).toBe('\x04'); // Ctrl+D
    expect(ctrlChar('к')).toBe('\x12'); // Ctrl+R
    expect(ctrlChar('л')).toBe('\x0b'); // Ctrl+K
  });
  it('nothing for keys Ctrl does not change', () => {
    expect(ctrlChar('1')).toBeNull();
    expect(ctrlChar('ab')).toBeNull();
    expect(ctrlChar('')).toBeNull();
  });
});

describe('pasteSeq', () => {
  it('wraps text in bracketed paste when the program asked for it, line breaks as CR', () => {
    expect(pasteSeq('a\nb\r\nc', true)).toBe('\x1b[200~a\rb\rc\x1b[201~');
    expect(pasteSeq('a\nb', false)).toBe('a\rb');
  });
  it('a paste marker inside the text cannot end the paste early', () => {
    expect(pasteSeq('x\x1b[201~rm -rf ~', true)).toBe('\x1b[200~xrm -rf ~\x1b[201~');
  });
});

describe('mobile settings', () => {
  it('merges a patch and drops values out of range', () => {
    const s = defaultMobileSettings();
    const n = mergeMobileSettings(s, { connection: { host: ' vm ', port: 2222, user: ' dev ' } });
    expect(n.connection).toEqual({ host: 'vm', port: 2222, user: 'dev' });
    expect(mergeMobileSettings(n, { connection: { port: 0 } }).connection.port).toBe(2222);
    expect(mergeMobileSettings(n, { appearance: { fontSize: 99 } }).appearance.fontSize).toBe(12);
    expect(mergeMobileSettings(n, { appearance: { theme: 'neon' as never } }).appearance.theme).toBe('dark');
    expect(s.appearance.theme).toBe('dark');
    expect(n.notifications.background).toBe(true);
    expect(mergeMobileSettings(n, { notifications: { background: false } }).notifications.background).toBe(
      false,
    );
    expect(
      mergeMobileSettings(n, { notifications: { background: 'no' as never } }).notifications.background,
    ).toBe(true);
    expect(mergeMobileSettings(n, { appearance: { theme: 'light', fontSize: 14 } }).appearance).toEqual({
      theme: 'light',
      fontSize: 14,
    });
  });
});

describe('dev bridge codec', () => {
  it('round-trips bytes, including large chunks', () => {
    const b = new Uint8Array(100_000).map((_, i) => (i * 7) & 0xff);
    expect(fromBase64(toBase64(b))).toEqual(b);
    expect(toBase64(new TextEncoder().encode('Привет'))).toBe('0J/RgNC40LLQtdGC');
  });
});

describe('menuOptions', () => {
  it('a permission prompt: the options with the pointer', () => {
    const screen = [
      ' Bash command',
      '   npm test',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      "   2. Yes, and don't ask again for npm test commands in /home/u/p",
      '   3. No, and tell Claude what to do differently (esc)',
      '',
    ];
    expect(menuOptions(screen)).toEqual([
      { n: 1, label: 'Yes', selected: true },
      { n: 2, label: "Yes, and don't ask again for npm test commands in /home/u/p", selected: false },
      { n: 3, label: 'No, and tell Claude what to do differently', selected: false },
    ]);
  });
  it('a question with five options and descriptions between them, the pointer anywhere', () => {
    const screen = [
      '☐ Database',
      'Which database?',
      '  1. Postgres',
      '     Relational, the default',
      '  2. SQLite',
      '❯ 3. MySQL',
      '  4. Redis',
      '  5. Type something.',
    ];
    expect(menuOptions(screen).map((o) => o.n)).toEqual([1, 2, 3, 4, 5]);
    expect(menuOptions(screen).find((o) => o.selected)?.label).toBe('MySQL');
  });
  it('a numbered list in an answer is not a menu; the last menu on screen wins', () => {
    expect(menuOptions(['Steps:', '1. Build', '2. Test', '3. Ship'])).toEqual([]);
    expect(menuOptions(['❯ 1. Old', '  2. Gone', 'later', '  1. New', '❯ 2. Now'])).toEqual([
      { n: 1, label: 'New', selected: false },
      { n: 2, label: 'Now', selected: true },
    ]);
    expect(menuOptions(['❯ 1. Alone'])).toEqual([]);
  });
});
