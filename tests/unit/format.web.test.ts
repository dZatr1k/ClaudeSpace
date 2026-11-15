import { describe, expect, it } from 'vitest';
import {
  dayGroup,
  formatAgo,
  formatDuration,
  formatTokens,
  matches,
  shortPath,
} from '../../src/renderer/lib/format';
import { fuzzyScore } from '../../src/renderer/lib/fuzzy';

const now = new Date(2026, 10, 8, 15, 0, 0).getTime(); // Sun 8 Nov 2026 15:00

describe('formatAgo', () => {
  it('сейчас / мин / ч / вчера / дата', () => {
    expect(formatAgo(now - 10_000, now)).toBe('сейчас');
    expect(formatAgo(now - 5 * 60_000, now)).toBe('5 мин');
    expect(formatAgo(now - 2 * 3_600_000, now)).toBe('2 ч');
    expect(formatAgo(new Date(2026, 10, 7, 14, 20).getTime(), now)).toBe('вчера 14:20');
    expect(formatAgo(new Date(2026, 10, 3, 9, 0).getTime(), now)).toBe('3 нояб.');
    expect(formatAgo(new Date(2025, 0, 3).getTime(), now)).toBe('3 янв. 2025');
    expect(formatAgo(null, now)).toBe('нет');
  });
  it('groups by day', () => {
    expect(dayGroup(now - 1000, now)).toBe('today');
    expect(dayGroup(new Date(2026, 10, 7, 10).getTime(), now)).toBe('yesterday');
    expect(dayGroup(new Date(2026, 10, 3, 10).getTime(), now)).toBe('week'); // Tue of the same week
    expect(dayGroup(new Date(2026, 9, 20).getTime(), now)).toBe('earlier');
  });
  it('tokens, durations, paths', () => {
    expect(formatTokens(1_234_567)).toBe('1.2M');
    expect(formatTokens(340_000)).toBe('340K');
    expect(formatTokens(12)).toBe('12');
    expect(formatDuration(125_000)).toBe('2 мин');
    expect(shortPath('/home/claude/projects/X', '/home/claude')).toBe('home/projects/X');
    expect(shortPath('/home/claude', '/home/claude')).toBe('home');
    expect(shortPath('/home/claudette/x', '/home/claude')).toBe('/home/claudette/x');
  });
  it('filter is case and ё/е insensitive', () => {
    expect(matches('ЁЖ', null, 'ежик')).toBe(true);
    expect(matches('game', 'MyGame')).toBe(true);
    expect(matches('zzz', 'MyGame')).toBe(false);
    expect(matches('  ', 'x')).toBe(true);
  });
  it('fuzzy prefers prefix and contiguous matches', () => {
    expect(fuzzyScore('mg', 'MyGame')).toBeGreaterThan(0);
    expect(fuzzyScore('mygame', 'MyGame')).toBeGreaterThan(fuzzyScore('mg', 'MyGame'));
    expect(fuzzyScore('xq', 'MyGame')).toBe(0);
  });
});

describe('axisTokens', () => {
  it('keeps chart axis labels short', async () => {
    const { axisTokens } = await import('../../src/renderer/lib/format');
    expect([0, 500, 2500, 2.5e6, 100e6, 300e6, 1.2e9].map(axisTokens)).toEqual([
      '0',
      '500',
      '2.5K',
      '2.5M',
      '100M',
      '300M',
      '1.2B',
    ]);
  });
});
