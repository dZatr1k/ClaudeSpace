// BACKLOG 6: on some GPUs the xterm WebGL renderer draws glyphs far too small (~60% on the user's PC). The cause is
// not known, so instead of guessing we check: an off-screen terminal with the user's font draws a row of «W» with
// WebGL, and the ink width read back from its canvas is compared with what Canvas2D measures for the same text. Far
// too narrow -> the app switches the setting to DOM, says so, and logs the numbers ([diag]).
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';

export const PROBE_TEXT = 'W'.repeat(12);
/** below this share of the expected ink width the WebGL glyphs count as broken (the bug drew ~0.6) */
export const MIN_RATIO = 0.8;

export interface ProbeResult {
  ok: boolean;
  ratio: number | null;
  inkPx: number | null;
  expectedPx: number | null;
  reason?: string;
}

/** decision on measured numbers (pure, unit-tested) */
export function judge(inkPx: number | null, expectedPx: number | null): ProbeResult {
  if (inkPx === null || expectedPx === null || expectedPx <= 0)
    return { ok: true, ratio: null, inkPx, expectedPx, reason: 'not measured' };
  const ratio = Math.round((inkPx / expectedPx) * 100) / 100;
  return { ok: ratio >= MIN_RATIO, ratio, inkPx, expectedPx };
}

/** horizontal extent (px) of pixels that differ from the background in an RGBA buffer */
export function inkWidth(data: Uint8ClampedArray, w: number, h: number): number | null {
  const bg = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
  let min = w;
  let max = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d =
        Math.abs((data[i] ?? 0) - bg[0]!) +
        Math.abs((data[i + 1] ?? 0) - bg[1]!) +
        Math.abs((data[i + 2] ?? 0) - bg[2]!);
      if (d > 96) {
        if (x < min) min = x;
        if (x > max) max = x;
      }
    }
  }
  return max >= min ? max - min + 1 : null;
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Run the probe with the terminal's font options. Never throws: anything odd counts as «not measured» (ok). */
export async function probeWebgl(opts: {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}): Promise<ProbeResult> {
  const host = document.createElement('div');
  // on screen but invisible: xterm pauses drawing for terminals outside the viewport (IntersectionObserver)
  host.style.cssText =
    'position:fixed;left:0;top:0;width:400px;height:80px;opacity:0;pointer-events:none;z-index:-1';
  document.body.appendChild(host);
  const term = new Terminal({
    ...opts,
    cols: 20,
    rows: 2,
    theme: { background: '#000000', foreground: '#ffffff' },
    cursorStyle: 'bar',
    cursorInactiveStyle: 'none',
  });
  try {
    term.open(host);
    const gl = new WebglAddon(true); // preserveDrawingBuffer: the canvas can be read back after the frame
    term.loadAddon(gl);
    await new Promise<void>((r) => term.write(PROBE_TEXT, () => r()));
    await frame();
    await frame();
    const canvases = [...host.querySelectorAll('canvas')];
    const canvas = canvases.find((c) => c.getContext('webgl2') !== null) ?? canvases[0];
    if (!canvas) return judge(null, null);
    const w = canvas.width;
    const rowH = Math.max(1, Math.round(canvas.height / 2));
    const c2 = document.createElement('canvas');
    c2.width = w;
    c2.height = rowH;
    const ctx = c2.getContext('2d');
    if (!ctx) return judge(null, null);
    ctx.drawImage(canvas, 0, 0, w, rowH, 0, 0, w, rowH);
    const ink = inkWidth(ctx.getImageData(0, 0, w, rowH).data, w, rowH);
    // the same text with Canvas2D at device pixels: what correctly sized glyphs cover
    const dpr = window.devicePixelRatio || 1;
    ctx.font = `${opts.fontSize * dpr}px ${opts.fontFamily}`;
    const m = ctx.measureText(PROBE_TEXT);
    const expected = Math.abs(m.actualBoundingBoxLeft) + Math.abs(m.actualBoundingBoxRight);
    return judge(ink, expected > 0 ? expected : null);
  } catch (e) {
    return { ...judge(null, null), reason: `probe failed: ${String(e)}` };
  } finally {
    term.dispose();
    host.remove();
  }
}
