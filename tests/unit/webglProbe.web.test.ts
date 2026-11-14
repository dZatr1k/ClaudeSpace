// BACKLOG 6: the WebGL glyph-size check. The decision and the ink measurement are pure; the real probe runs in e2e.
import { describe, expect, it } from 'vitest';
import { inkWidth, judge, MIN_RATIO } from '../../src/renderer/lib/webglProbe';

function row(w: number, h: number, from: number, to: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const ink = x >= from && x <= to && y === 1;
      d[i] = d[i + 1] = d[i + 2] = ink ? 255 : 10;
      d[i + 3] = 255;
    }
  return d;
}

describe('webgl probe', () => {
  it('measures the ink extent against the background', () => {
    expect(inkWidth(row(50, 4, 5, 34), 50, 4)).toBe(30);
    expect(inkWidth(row(50, 4, 60, 70), 50, 4)).toBeNull(); // nothing drawn
  });

  it('glyphs at ~60% are broken, normal ones pass, unmeasured never switches', () => {
    expect(judge(60, 100)).toMatchObject({ ok: false, ratio: 0.6 });
    expect(judge(97, 100)).toMatchObject({ ok: true, ratio: 0.97 });
    expect(judge(MIN_RATIO * 100, 100).ok).toBe(true);
    expect(judge(null, 100).ok).toBe(true);
    expect(judge(50, 0).ok).toBe(true);
  });
});
