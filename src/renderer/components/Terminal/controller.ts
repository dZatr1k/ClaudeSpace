// Terminal instances (one xterm per tab, kept alive while the tab exists) and their channel lifecycle:
// open/attach, data with acks (flow control), exit -> detached/ended/exited, offline -> overlay, reconnect.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { checkLive, probeWebgl } from '../../lib/webglProbe';
import type { ProbeResult } from '../../lib/webglProbe';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import type { Tab } from '@shared/model';
import type { Settings } from '@shared/settings';
import { agent, invoke, on } from '../../bridge';
import { useTabs } from '../../stores/tabs';
import { openLink } from '../../lib/ports';
import { useConn } from '../../stores/conn';
import { useData } from '../../stores/data';
import { useUi } from '../../stores/ui';
import { t } from '../../i18n/ru';
import { terminalFontFamily, terminalTheme } from '../../theme/terminalThemes';

export interface TermHandle {
  tabId: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  host: HTMLDivElement | null;
  opened: boolean;
  ackBytes: number;
  ackTimer: number | null;
  received: number;
  webgl: WebglAddon | null;
}

const handles = new Map<string, TermHandle>();
const ACK_BATCH = 64 * 1024;

export function getHandle(tabId: string): TermHandle | undefined {
  return handles.get(tabId);
}

function settings(): Settings | null {
  return useUi.getState().settings;
}

export function termOptions() {
  const s = settings()?.terminal;
  const delta = useUi.getState().fontDelta;
  return {
    fontFamily: terminalFontFamily(s?.fontFamily ?? 'JetBrains Mono'),
    fontSize: Math.max(8, Math.min(32, (s?.fontSize ?? 15) + delta)),
    lineHeight: s?.lineHeight ?? 1.2,
    cursorStyle: (s?.cursorStyle ?? 'block') as 'block' | 'bar',
    cursorBlink: s?.cursorBlink ?? true,
    theme: terminalTheme(useUi.getState().dark),
  };
}

export function createHandle(tab: Tab): TermHandle {
  const existing = handles.get(tab.id);
  if (existing) return existing;
  const s = settings()?.terminal;
  const term = new Terminal({
    ...termOptions(),
    allowProposedApi: true,
    scrollback: tab.kind === 'tmux' ? 1000 : (s?.scrollback ?? 5000),
    macOptionIsMeta: true,
    rightClickSelectsWord: false,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 1,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  const uni = new Unicode11Addon();
  term.loadAddon(uni);
  term.unicode.activeVersion = '11';
  // http://localhost:N (and 127.0.0.1 / 0.0.0.0) is a port on the VM: forward it to this PC, then open
  term.loadAddon(new WebLinksAddon((_e, uri) => void openLink(uri)));
  // OSC 52 from tmux copy-mode -> Windows clipboard (write only; reading the clipboard via OSC 52 is refused)
  term.loadAddon(
    new ClipboardAddon(undefined, {
      readText: () => '',
      writeText: (_sel, text) => {
        if (text.length <= 1024 * 1024) void invoke('clipboard.write', { text });
      },
    }),
  );
  const h: TermHandle = {
    tabId: tab.id,
    term,
    fit,
    search,
    host: null,
    opened: false,
    ackBytes: 0,
    ackTimer: null,
    received: 0,
    webgl: null,
  };
  term.onData((data) => sendInput(tab.id, data, false));
  term.onBinary((data) => sendInput(tab.id, data, true));
  term.onResize(({ cols, rows }) => {
    if (tabOf(tab.id)?.term === 'live') void invoke('term.resize', { tabId: tab.id, cols, rows });
  });
  handles.set(tab.id, h);
  return h;
}

export function mountHandle(h: TermHandle, el: HTMLDivElement): void {
  if (h.opened) {
    if (h.host !== el && h.term.element) el.appendChild(h.term.element);
    h.host = el;
    return;
  }
  h.host = el;
  h.term.open(el);
  h.opened = true;
  hidePointerWhileTyping(h.term.element);
  syncRenderer(h);
  safeFit(h);
  fontDiag(h);
}

/**
 * BACKLOG 1: the mouse pointer flickered while typing. Windows hides it on a keypress ("hide pointer while typing"),
 * then every terminal redraw under it made Chromium show it again. Hide it ourselves until the mouse moves.
 */
function hidePointerWhileTyping(el: HTMLElement | undefined): void {
  if (!el) return;
  el.addEventListener(
    'keydown',
    (e) => {
      if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) el.classList.add('cs-typing');
    },
    true,
  );
  el.addEventListener('mousemove', () => el.classList.remove('cs-typing'));
}

/** once per run: does WebGL draw glyphs at the right size on this GPU? (lib/webglProbe.ts, BACKLOG 6) */
let probe: Promise<boolean> | null = null;
let probePassed = false;
/** the probe failed and the setting was switched to DOM: choosing WebGL again after that is the user's call */
let probeOverridable = false;

function webglChecked(): boolean {
  if (probePassed || probeOverridable) return true;
  if (!probe) {
    probe = probeWebgl(termOptions()).then((r) => {
      void invoke('diag.log', { text: `[webgl-probe] ${JSON.stringify(r)}` });
      if (r.ok) {
        probePassed = true;
        for (const x of handles.values()) syncRenderer(x);
        return true;
      }
      webglFailed(r);
      return false;
    });
  }
  return false;
}

/** glyphs came out too small: switch the setting to DOM (which detaches WebGL everywhere) and say so */
function webglFailed(r: ProbeResult): void {
  const ui = useUi.getState();
  probeOverridable = true;
  void invoke('settings.set', { terminal: { renderer: 'dom' } }).then((next) => {
    ui.set({ settings: next });
    for (const x of handles.values()) syncRenderer(x);
  });
  ui.toast(t.settings.webglBroken(Math.round((r.ratio ?? 0) * 100)), 'info', undefined, 10_000);
}

/** The off-screen probe passed, but the real terminal may still differ: once per run, the first visible terminal
 * that draws with WebGL is measured too (checkLive), logged, and switched back to DOM if its glyphs are too small. */
let liveChecked = false;
function scheduleLiveCheck(h: TermHandle): void {
  if (liveChecked || probeOverridable) return;
  let tries = 0;
  const run = () => {
    if (liveChecked || !h.webgl || !h.host) return;
    const r = h.host.clientWidth > 50 ? checkLive(h.term, h.host) : null;
    if (!r || (r.ratio === null && ++tries < 10)) {
      window.setTimeout(run, 3000); // hidden tab or nothing on screen yet
      return;
    }
    liveChecked = true;
    void invoke('diag.log', { text: `[webgl-live] ${JSON.stringify(r).slice(0, 4000)}` });
    if (!r.ok) webglFailed(r);
  };
  window.setTimeout(run, 1500);
}

/** WebGL or the built-in DOM renderer, per settings; switching works on a live terminal. WebGL is attached only
 * after the probe passed; until then (and if it fails) the DOM renderer draws. */
function syncRenderer(h: TermHandle): void {
  const want = (settings()?.terminal.renderer ?? 'webgl') === 'webgl' && webglChecked();
  if (!want && h.webgl) {
    h.webgl.dispose();
    h.webgl = null;
  } else if (want && !h.webgl && h.opened) {
    try {
      const gl = new WebglAddon(true); // preserveDrawingBuffer: the live check reads the canvas back
      gl.onContextLoss(() => {
        gl.dispose();
        h.webgl = null;
      });
      h.term.loadAddon(gl);
      h.webgl = gl;
      scheduleLiveCheck(h);
    } catch {
      h.webgl = null; // DOM renderer fallback
    }
  }
}

let diagDone = false;

/**
 * One-off font diagnostics into main.log ([diag]): which families the renderer can really use, what xterm got,
 * the measured cell and the renderer. A family whose canvas width equals the generic fallback's is not found.
 */
function fontDiag(h: TermHandle): void {
  if (diagDone) return;
  diagDone = true;
  window.setTimeout(() => {
    try {
      const px = h.term.options.fontSize ?? 16;
      const ctx = document.createElement('canvas').getContext('2d');
      const sample = 'mmmmmWWWWWiiiiiЖЖЖЖЖ';
      const width = (font: string) => {
        if (!ctx) return -1;
        ctx.font = font;
        return Math.round(ctx.measureText(sample).width * 10) / 10;
      };
      const mono = width(`${px}px monospace`);
      const serif = width(`${px}px serif`);
      const fams: Record<string, string> = {};
      for (const f of ['Cascadia Mono', 'Cascadia Code', 'Consolas', 'JetBrains Mono', 'Courier New']) {
        fams[f] =
          `check=${document.fonts.check(`${px}px "${f}"`)} ` +
          `w=${width(`${px}px "${f}", monospace`)} wSerif=${width(`${px}px "${f}", serif`)}`;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dims = (h.term as any)._core?._renderService?.dimensions?.css?.cell;
      const text = JSON.stringify({
        dpr: window.devicePixelRatio,
        fontFamily: h.term.options.fontFamily,
        fontSize: px,
        lineHeight: h.term.options.lineHeight,
        cell: dims ? { w: dims.width, h: dims.height } : null,
        renderer: h.webgl ? 'webgl' : 'dom',
        generic: { monospace: mono, serif },
        fams,
        termFontNow: width(`${px}px ${h.term.options.fontFamily ?? ''}`),
      });
      void invoke('diag.log', { text: text.slice(0, 8000) });
    } catch (e) {
      void invoke('diag.log', { text: `fontDiag failed: ${String(e)}` });
    }
  }, 1500);
}

export function disposeHandle(tabId: string): void {
  const h = handles.get(tabId);
  if (!h) return;
  handles.delete(tabId);
  if (h.ackTimer) window.clearTimeout(h.ackTimer);
  h.term.dispose();
}

export function safeFit(h: TermHandle): { cols: number; rows: number } {
  try {
    if (h.host && h.host.clientWidth > 20 && h.host.clientHeight > 20) h.fit.fit();
  } catch {
    /* not visible yet */
  }
  return { cols: Math.max(2, h.term.cols), rows: Math.max(2, h.term.rows) };
}

// Latin, Cyrillic and box-drawing samples: each @font-face subset is fetched only for the ranges it covers.
const FONT_SAMPLE = 'AaWwMm@#0 ЖжЯяЩщ ─│┌';

/**
 * xterm.js measures the cell size once, from whatever font is usable at that moment. If the bundled web font
 * is still loading, the cell is measured with a fallback font and the real glyphs then overlap. So: load the
 * font (regular + bold) before terminals are created, and re-measure whenever a font finishes loading late.
 */
export async function loadTermFont(family?: string, size?: number): Promise<void> {
  const s = settings()?.terminal;
  const fam = `"${family ?? s?.fontFamily ?? 'JetBrains Mono'}"`;
  const px = size ?? s?.fontSize ?? 15;
  const loads = [`${px}px ${fam}`, `bold ${px}px ${fam}`].map((f) =>
    document.fonts.load(f, FONT_SAMPLE).catch(() => []),
  );
  await Promise.race([Promise.all(loads), new Promise((r) => window.setTimeout(r, 2000))]);
}

export function applyOptionsToAll(): void {
  const o = termOptions();
  for (const h of handles.values()) {
    h.term.options.fontSize = o.fontSize;
    h.term.options.lineHeight = o.lineHeight;
    h.term.options.cursorStyle = o.cursorStyle;
    h.term.options.cursorBlink = o.cursorBlink;
    h.term.options.theme = o.theme;
    syncRenderer(h);
  }
  void loadTermFont().then(remeasureAll);
}

/** Force xterm to re-measure the cell and redraw glyphs (after a font load or a font change). */
export function remeasureAll(): void {
  const o = termOptions();
  for (const h of handles.values()) {
    // xterm re-measures only when fontFamily actually changes; a trailing space is ignored by CSS
    h.term.options.fontFamily =
      h.term.options.fontFamily === o.fontFamily ? `${o.fontFamily} ` : o.fontFamily;
    h.webgl?.clearTextureAtlas();
    safeFit(h);
  }
}

function tabOf(id: string): Tab | undefined {
  return useTabs.getState().tabs.find((t) => t.id === id);
}

function sendInput(tabId: string, data: string, binary: boolean) {
  // input is blocked unless the channel is live (no buffering: keys could go to the wrong place)
  if (tabOf(tabId)?.term !== 'live') return;
  void invoke('term.write', { tabId, data, ...(binary ? { binary: true } : {}) });
}

export function writeToTab(tabId: string, data: string): void {
  sendInput(tabId, data, false);
}

function ack(h: TermHandle, n: number) {
  h.ackBytes += n;
  if (h.ackBytes >= ACK_BATCH) {
    void invoke('term.ack', { tabId: h.tabId, bytes: h.ackBytes });
    h.ackBytes = 0;
  } else if (!h.ackTimer) {
    h.ackTimer = window.setTimeout(() => {
      h.ackTimer = null;
      if (h.ackBytes) void invoke('term.ack', { tabId: h.tabId, bytes: h.ackBytes });
      h.ackBytes = 0;
    }, 30);
  }
}

const opening = new Set<string>();

/** Open (or re-open) the PTY channel of a tab. tmux tabs: xterm.reset() + attach (tmux redraws everything). */
export async function openChannel(tabId: string): Promise<void> {
  const tab = tabOf(tabId);
  const h = handles.get(tabId);
  if (!tab || !h || opening.has(tabId)) return;
  const upd = useTabs.getState().update;
  if (useConn.getState().state.kind !== 'online') {
    upd(tabId, { term: 'offline' });
    return;
  }
  opening.add(tabId);
  upd(tabId, { term: 'connecting', error: undefined, exitCode: undefined });
  h.term.reset();
  const { cols, rows } = safeFit(h);
  try {
    const res = await Promise.race([
      invoke('term.open', {
        tabId,
        kind: tab.kind,
        ...(tab.session ? { session: tab.session } : {}),
        ...(tab.cwd ? { cwd: tab.cwd } : {}),
        ...(tab.url ? { url: tab.url } : {}),
        ...(tab.dest ? { dest: tab.dest } : {}),
        cols,
        rows,
      }),
      new Promise<{ ok: false; error: string }>((r) =>
        setTimeout(() => r({ ok: false, error: 'timeout' }), 10_000),
      ),
    ]);
    if (res.ok) {
      upd(tabId, { term: 'live' });
      if (useTabs.getState().activeId === tabId) h.term.focus();
      void invoke('term.resize', { tabId, cols: h.term.cols, rows: h.term.rows });
    } else {
      if (res.error === 'timeout') void invoke('term.close', { tabId });
      upd(tabId, {
        term: 'error',
        error: res.error === 'timeout' ? 'Подключение не удалось за 10 с' : res.error,
      });
    }
  } finally {
    opening.delete(tabId);
  }
}

async function onExit(tabId: string, code: number | null) {
  const tab = tabOf(tabId);
  if (!tab) return;
  const upd = useTabs.getState().update;
  if (useConn.getState().state.kind !== 'online') {
    upd(tabId, { term: 'offline' });
    return;
  }
  if (tab.kind !== 'tmux') {
    upd(tabId, { term: 'exited', exitCode: code });
    return;
  }
  try {
    const { sessions } = await agent('list_active');
    const alive = sessions.some((s) => s.name === tab.session);
    upd(tabId, { term: alive ? 'detached' : 'ended', exitCode: code });
  } catch {
    upd(tabId, { term: 'offline' });
  }
}

let wired = false;

/** Global listeners: data, exit, connection transitions. Call once. */
export function wireTerminals(): void {
  if (wired) return;
  wired = true;
  on('term.data', ({ tabId, data }) => {
    const h = handles.get(tabId);
    if (!h) return;
    const n = data.byteLength;
    h.received += n;
    h.term.write(data, () => ack(h, n));
  });
  on('term.exit', ({ tabId, code }) => void onExit(tabId, code));

  let wasOnline = useConn.getState().state.kind === 'online';
  useConn.subscribe((s) => {
    const online = s.state.kind === 'online';
    if (wasOnline && !online) {
      useData.getState().markStale();
      const { tabs, update } = useTabs.getState();
      for (const t of tabs)
        if (t.term === 'live' || t.term === 'connecting') update(t.id, { term: 'offline' });
    }
    wasOnline = online;
  });
  // once online and the first active_changed arrived: reattach tabs that were waiting
  useData.subscribe((d, prev) => {
    if (d.sessionsSynced && !prev.sessionsSynced) reattachAll();
  });
}

export function reattachAll(): void {
  if (useConn.getState().state.kind !== 'online') return;
  const names = new Set(useData.getState().sessions.map((s) => s.name));
  const { tabs, update } = useTabs.getState();
  for (const t of tabs) {
    if (t.term !== 'offline' && t.term !== 'connecting') continue;
    if (t.kind === 'tmux') {
      if (t.session && names.has(t.session)) void openChannel(t.id);
      else update(t.id, { term: 'ended' });
    } else if (handles.get(t.id)?.received) {
      update(t.id, { term: 'exited', exitCode: null, error: 'обрыв связи' });
    } else {
      void openChannel(t.id);
    }
  }
}

export function closeChannel(tabId: string): void {
  void invoke('term.close', { tabId });
}
