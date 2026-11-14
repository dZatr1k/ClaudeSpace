// Helpers of the right panel «Сведения» for a tmux session: status line, clock, model name, plurals.
import { describe, expect, it } from 'vitest';
import type { ClaudeProc, Session } from '../../src/shared/model';
import { formatClock, formatModel, plural } from '../../src/renderer/lib/format';
import { primaryClaude, statusLine } from '../../src/renderer/lib/status';

const now = new Date(2026, 10, 8, 15, 0, 0).getTime(); // Sun 8 Nov 2026 15:00

describe('statusLine', () => {
  it('думает N / ждёт ответа с HH:MM / простаивает / raw', () => {
    expect(statusLine('busy', now - 125_000, now)).toBe('думает 2 мин');
    expect(statusLine('busy', now - 20_000, now)).toBe('думает 20 с');
    expect(statusLine('busy', now - 65 * 60_000, now)).toBe('думает 1 ч 5 мин');
    expect(statusLine('busy', 0, now)).toBe('думает');
    expect(statusLine('waiting', new Date(2026, 10, 8, 14, 5).getTime(), now)).toBe('ждёт ответа с 14:05');
    expect(statusLine('waiting', new Date(2026, 10, 7, 9, 30).getTime(), now)).toBe(
      'ждёт ответа с вчера 09:30',
    );
    expect(statusLine('idle', now - 1000, now)).toBe('простаивает');
    expect(statusLine('compacting', now, now)).toBe('compacting');
  });
});

describe('formatClock', () => {
  it('today / yesterday / older', () => {
    expect(formatClock(new Date(2026, 10, 8, 9, 7).getTime(), now)).toBe('09:07');
    expect(formatClock(new Date(2026, 10, 7, 23, 59).getTime(), now)).toBe('вчера 23:59');
    expect(formatClock(new Date(2026, 10, 1, 8, 0).getTime(), now)).toBe('01.11 08:00');
    expect(formatClock(null, now)).toBe('нет');
  });
});

describe('formatModel', () => {
  it('short family + version', () => {
    expect(formatModel('claude-opus-4-5-20251101')).toBe('opus 4.5');
    expect(formatModel('claude-sonnet-4-5')).toBe('sonnet 4.5');
    expect(formatModel('claude-3-5-sonnet-20241022')).toBe('sonnet 3.5');
    expect(formatModel('claude-opus-4-6[1m]')).toBe('opus 4.6');
    expect(formatModel('claude-haiku')).toBe('haiku');
    expect(formatModel('gpt-x')).toBe('gpt-x');
    expect(formatModel(null)).toBe('');
  });
});

describe('plural', () => {
  it('Russian forms', () => {
    const f: [string, string, string] = ['клиент', 'клиента', 'клиентов'];
    expect([1, 2, 4, 5, 11, 12, 21, 22, 25, 101].map((n) => plural(n, f))).toEqual([
      'клиент',
      'клиента',
      'клиента',
      'клиентов',
      'клиентов',
      'клиентов',
      'клиент',
      'клиента',
      'клиентов',
      'клиент',
    ]);
  });
});

describe('primaryClaude', () => {
  const proc = (chatId: string, status: string, statusAt: number): ClaudeProc => ({
    chatId,
    status,
    statusAt,
    pid: 1,
    window: '1',
    pane: '%1',
    name: null,
  });
  const sess = (claude: ClaudeProc[]): Session => ({
    name: 's',
    attached: 1,
    activity: now,
    windows: 1,
    path: '/home/u',
    command: 'claude',
    claude,
  });
  it('waiting > busy > idle, then the freshest; none -> null', () => {
    expect(primaryClaude(sess([]))).toBeNull();
    expect(primaryClaude(sess([proc('a', 'idle', 5), proc('b', 'busy', 1)]))?.chatId).toBe('b');
    expect(primaryClaude(sess([proc('a', 'busy', 9), proc('b', 'waiting', 1)]))?.chatId).toBe('b');
    expect(primaryClaude(sess([proc('a', 'busy', 1), proc('b', 'busy', 2)]))?.chatId).toBe('b');
  });
});
