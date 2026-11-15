// Time and number formatting (analogue of ccdata.ago/when): «сейчас», «5 мин», «2 ч», «вчера 14:20», «3 нояб.».
const MONTHS = [
  'янв.',
  'февр.',
  'марта',
  'апр.',
  'мая',
  'июня',
  'июля',
  'авг.',
  'сент.',
  'окт.',
  'нояб.',
  'дек.',
];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function formatAgo(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return 'нет';
  const diff = now - ms;
  if (diff < 60_000) return 'сейчас';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} мин`;
  const today = startOfDay(now);
  if (ms >= today) return `${Math.floor(diff / 3_600_000)} ч`;
  const d = new Date(ms);
  if (ms >= today - 86_400_000) return `вчера ${hhmm(d)}`;
  const y = new Date(now).getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== y ? ` ${d.getFullYear()}` : ''}`;
}

/** Short duration for "не было 2 мин": seconds -> «45 с», «2 мин», «1 ч 5 мин». */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

/** Clock time for "с 14:05": today -> «14:05», yesterday -> «вчера 14:05», older -> «08.11 14:05». */
export function formatClock(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return 'нет';
  const d = new Date(ms);
  const today = startOfDay(now);
  if (ms >= today) return hhmm(d);
  if (ms >= today - 86_400_000) return `вчера ${hhmm(d)}`;
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${hhmm(d)}`;
}

/** 'claude-opus-4-5-20251101' -> 'opus 4.5', 'claude-3-5-sonnet-20241022' -> 'sonnet 3.5'; unknown ids as is. */
export function formatModel(id: string | null | undefined): string {
  if (!id) return '';
  const m = /^claude-(.+)$/.exec(id.replace(/\[.*\]$/, ''));
  if (!m) return id;
  const parts = (m[1] as string).split('-').filter((x) => !/^\d{8}$/.test(x));
  const family = parts.find((x) => !/^\d+$/.test(x));
  const ver = parts.filter((x) => /^\d{1,2}$/.test(x));
  if (!family) return id;
  return ver.length ? `${family} ${ver.join('.')}` : family;
}

/** Russian plural: plural(2, ['клиент', 'клиента', 'клиентов']) -> 'клиента'. */
export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b === 1) return forms[0];
  if (b >= 2 && b <= 4) return forms[1];
  return forms[2];
}

export function formatWhen(ms: number | null | undefined): string {
  if (!ms) return 'нет';
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getFullYear()).slice(2)} ${hhmm(d)}`;
}

export function formatTokens(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}K`;
  return String(v);
}

/** axis labels: short, no trailing .0 (300M, 2.5M, 1.2B) so they fit left of the plot */
export function axisTokens(v: number): string {
  const f = (n: number, unit: string) => `${Number(n.toFixed(1))}${unit}`;
  if (v >= 1e9) return f(v / 1e9, 'B');
  if (v >= 1e6) return f(v / 1e6, 'M');
  if (v >= 1e3) return f(v / 1e3, 'K');
  return String(v);
}

export function formatLeft(min: number | null | undefined): string {
  if (min == null) return '';
  return `${Math.floor(min / 60)}ч${String(min % 60).padStart(2, '0')}м`;
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} МБ`;
  if (n < 1024) return `${n} Б`;
  return `${Math.round(n / 1024)} КБ`;
}

export function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return d ? `${d} д ${h} ч` : `${h} ч ${Math.floor((sec % 3600) / 60)} мин`;
}

export type DayGroup = 'today' | 'yesterday' | 'week' | 'earlier';

export function dayGroup(ms: number, now = Date.now()): DayGroup {
  const today = startOfDay(now);
  if (ms >= today) return 'today';
  if (ms >= today - 86_400_000) return 'yesterday';
  const dow = (new Date(now).getDay() + 6) % 7; // Monday = 0
  if (ms >= today - dow * 86_400_000) return 'week';
  return 'earlier';
}

/** "/home/claude/projects/X" -> "~/projects/X" */
export function shortPath(p: string | null | undefined, home: string | null): string {
  if (!p) return '‹папка?›';
  // the home folder is shown as "home" (same name as its project), e.g. home/projects/MyGame
  if (home && p === home) return 'home';
  if (home && p.startsWith(home + '/')) return 'home/' + p.slice(home.length + 1);
  return p;
}

export function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

/** case- and ё/е-insensitive normalisation for filters */
export function norm(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е');
}

export function matches(q: string, ...fields: (string | null | undefined)[]): boolean {
  const n = norm(q.trim());
  if (!n) return true;
  return fields.some((f) => f && norm(f).includes(n));
}
