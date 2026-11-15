// BACKLOG 6: the xterm WebGL renderer drew glyphs far too small (2/3 of the cell). The cause was the canvas font
// setter (lib/canvasFont.ts has the fix); this check stays as a safety net: an off-screen terminal with the user's
// font draws a row of «W» with WebGL, and the height of the ink read back from its canvas is compared with the same
// text drawn by Canvas2D. Far too small -> the app switches the setting to DOM, says so, and logs the numbers.
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';

export const PROBE_TEXT = 'W'.repeat(12);
/** below this share of the expected ink size the WebGL glyphs count as broken (the bug drew ~0.67) */
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
    const data = ctx.getImageData(0, 0, w, rowH).data;
    const ink = inkHeight(data, w, rowH, modeColor(data));
    // the same text with Canvas2D at device pixels: the height correctly sized glyphs cover. (Width would not do:
    // glyphs sit at their cells, so a row of too-small glyphs is still almost as wide.)
    const dpr = window.devicePixelRatio || 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, rowH);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.font = `${opts.fontSize * dpr}px ${opts.fontFamily}`;
    ctx.fillText(PROBE_TEXT, 0, rowH / 2);
    const expected = inkHeight(ctx.getImageData(0, 0, w, rowH).data, w, rowH, [0, 0, 0]);
    return judge(ink, expected);
  } catch (e) {
    return { ...judge(null, null), reason: `probe failed: ${String(e)}` };
  } finally {
    term.dispose();
    host.remove();
  }
}

/** vertical extent (px) of pixels that differ from the background colour bg in an RGBA buffer */
export function inkHeight(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  bg: [number, number, number],
): number | null {
  let min = h;
  let max = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d =
        Math.abs((data[i] ?? 0) - bg[0]) +
        Math.abs((data[i + 1] ?? 0) - bg[1]) +
        Math.abs((data[i + 2] ?? 0) - bg[2]);
      if (d > 96) {
        if (y < min) min = y;
        if (y > max) max = y;
        break;
      }
    }
  }
  return max >= min ? max - min + 1 : null;
}

/** the most frequent colour of an RGBA buffer: the background of a row of text */
export function modeColor(data: Uint8ClampedArray): [number, number, number] {
  const count = new Map<number, number>();
  let best = 0;
  let bestN = 0;
  for (let i = 0; i + 2 < data.length; i += 4) {
    const k = ((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0);
    const n = (count.get(k) ?? 0) + 1;
    count.set(k, n);
    if (n > bestN) {
      bestN = n;
      best = k;
    }
  }
  return [(best >> 16) & 255, (best >> 8) & 255, best & 255];
}

export interface LiveResult extends ProbeResult {
  dims?: unknown;
  row?: string;
}

/**
 * The same check on a real terminal that already draws with WebGL (its addon made with preserveDrawingBuffer):
 * the busiest visible row is read back from the canvas and the height of its ink is compared with the same text
 * drawn by Canvas2D at the cell positions. Also returns xterm's cell / canvas sizes for the log. Never throws.
 */
export function checkLive(term: Terminal, host: HTMLElement): LiveResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dimsRaw = (term as any)._core?._renderService?.dimensions;
  const canvas = [...host.querySelectorAll('canvas')].find((c) => c.getContext('webgl2') !== null);
  const dims = {
    dpr: window.devicePixelRatio,
    css: dimsRaw?.css,
    device: dimsRaw?.device,
    canvas: canvas
      ? { w: canvas.width, h: canvas.height, cssW: canvas.clientWidth, cssH: canvas.clientHeight }
      : null,
  };
  try {
    const cellW: number | undefined = dimsRaw?.device?.cell?.width;
    const cellH: number | undefined = dimsRaw?.device?.cell?.height;
    if (!canvas || !cellW || !cellH) return { ...judge(null, null), dims };
    // the visible row with the most non-space characters
    const buf = term.buffer.active;
    let best = -1;
    let bestText = '';
    for (let y = 0; y < term.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      const s = line?.translateToString(true) ?? '';
      // a coloured background (tmux status line, selections, inverse) would count as ink
      let plainBg = true;
      for (let x = 0; line && x < s.length && plainBg; x++) {
        const cell = line.getCell(x);
        if (cell && (!cell.isBgDefault() || cell.isInverse())) plainBg = false;
      }
      if (!plainBg) continue;
      // box drawing, blocks and icon fonts are drawn by xterm itself at full cell size: they would hide the bug
      if (/[\u2500-\u259f\ue000-\uf8ff]|[^\u0020-\u04ff\u2000-\u206f]/.test(s)) continue;
      if (s.replace(/\s/g, '').length > bestText.replace(/\s/g, '').length) {
        best = y;
        bestText = s;
      }
    }
    if (best < 0 || bestText.replace(/\s/g, '').length < 6) return { ...judge(null, null), dims };
    const w = canvas.width;
    const h = Math.round(cellH);
    const c2 = document.createElement('canvas');
    c2.width = w;
    c2.height = h;
    const ctx = c2.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { ...judge(null, null), dims };
    ctx.drawImage(canvas, 0, Math.round(best * cellH), w, h, 0, 0, w, h);
    const glData = ctx.getImageData(0, 0, w, h).data;
    const bg = modeColor(glData);
    const inkGl = inkHeight(glData, w, h, bg);
    // the same characters with Canvas2D, white on black, each at its cell
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.font = `${(term.options.fontSize ?? 14) * window.devicePixelRatio}px ${term.options.fontFamily ?? 'monospace'}`;
    [...bestText].forEach((ch, i) => ch.trim() && ctx.fillText(ch, i * cellW, h / 2));
    const inkRef = inkHeight(ctx.getImageData(0, 0, w, h).data, w, h, [0, 0, 0]);
    return { ...judge(inkGl, inkRef), dims, row: bestText.trim().slice(0, 40) };
  } catch (e) {
    return { ...judge(null, null), dims, reason: `live check failed: ${String(e)}` };
  }
}
