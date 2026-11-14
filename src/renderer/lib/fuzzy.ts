// Small fuzzy scorer for the palette: subsequence match with bonuses for word starts and contiguity.
import { norm } from './format';

export function fuzzyScore(query: string, text: string): number {
  const q = norm(query.trim());
  if (!q) return 1;
  const s = norm(text);
  const idx = s.indexOf(q);
  if (idx >= 0) return 1000 - idx + (idx === 0 || /[\s/_.-]/.test(s[idx - 1] ?? '') ? 200 : 0);
  let score = 0;
  let si = 0;
  let prev = -2;
  for (const ch of q) {
    const found = s.indexOf(ch, si);
    if (found < 0) return 0;
    score += found === prev + 1 ? 8 : 1;
    if (found === 0 || /[\s/_.-]/.test(s[found - 1] ?? '')) score += 5;
    prev = found;
    si = found + 1;
  }
  return score;
}
