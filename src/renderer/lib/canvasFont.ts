// BACKLOG 6, the cause: the canvas `font` setter in Electron 45 (Chromium) rejects a value that starts with a space
// and silently keeps the default «10px sans-serif». The xterm WebGL renderer builds its glyph font as
// `${italic} ${weight} ${size}px ${family}`, which starts with a space for upright text, so every glyph in the
// texture atlas was drawn at 10px: about 2/3 of a 15px cell. Trimming the value before it reaches the setter
// fixes it for every canvas (2D and Offscreen).
export function trimCanvasFont(): void {
  const protos = [
    globalThis.CanvasRenderingContext2D?.prototype,
    globalThis.OffscreenCanvasRenderingContext2D?.prototype,
  ];
  for (const proto of protos) {
    if (!proto) continue;
    const desc = Object.getOwnPropertyDescriptor(proto, 'font');
    if (!desc?.set || !desc.get || (desc.set as { trimmed?: boolean }).trimmed) continue;
    const set = desc.set;
    const trimmed = function (this: CanvasRenderingContext2D, v: string) {
      set.call(this, typeof v === 'string' ? v.trim() : v);
    };
    (trimmed as { trimmed?: boolean }).trimmed = true;
    Object.defineProperty(proto, 'font', { ...desc, set: trimmed });
  }
}

trimCanvasFont();
