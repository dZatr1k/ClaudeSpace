// The terminal of the open chat: one xterm attached to a tmux session over the bridge. Same channel rules as the
// desktop controller (renderer/components/Terminal/controller.ts): acks for flow control, input only while the
// channel is live, reattach after a reconnect. Phone specifics: the soft keyboard opens only in direct typing mode,
// text from the input field goes in as a bracketed paste, the tmux status line is cut off to save rows.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { create } from 'zustand';
import { useConn } from '../renderer/stores/conn';
import { useData } from '../renderer/stores/data';
import { terminalFontFamily, terminalTheme } from '../renderer/theme/terminalThemes';
import { agent, invoke, on } from './bridge';
import { ctrlChar, keySeq, pasteSeq } from './keys';
import type { KeyId } from './keys';
import { m } from './strings';
import { useApp } from './store';

export type TermState = 'connecting' | 'live' | 'detached' | 'ended' | 'offline' | 'error';

interface TermStore {
  state: TermState;
  error: string | null;
  /** Ctrl from the key row: the next key goes with Ctrl */
  ctrl: boolean;
  /** the soft keyboard types into the terminal itself instead of the input field */
  direct: boolean;
  set(p: Partial<TermStore>): void;
}

export const useTerm = create<TermStore>((set) => ({
  state: 'connecting',
  error: null,
  ctrl: false,
  direct: false,
  set: (p) => set(p),
}));

interface Current {
  tabId: string;
  session: string;
  term: Terminal;
  fit: FitAddon;
  host: HTMLElement;
  ackBytes: number;
  ackTimer: number | null;
  opening: boolean;
  dispose: (() => void)[];
}

let cur: Current | null = null;
const ACK_BATCH = 64 * 1024;
const FONT_SAMPLE = 'AaWwMm@#0 ЖжЯяЩщ ─│┌';

function options() {
  const s = useApp.getState().settings?.appearance;
  return {
    fontFamily: terminalFontFamily('JetBrains Mono'),
    fontSize: s?.fontSize ?? 12,
    lineHeight: 1.15,
    theme: terminalTheme(useApp.getState().dark),
  };
}

/** xterm measures the cell once: load the bundled font first, or the cell is measured with a fallback */
export async function loadTermFont(): Promise<void> {
  const px = options().fontSize;
  const loads = [`${px}px "JetBrains Mono"`, `bold ${px}px "JetBrains Mono"`].map((f) =>
    document.fonts.load(f, FONT_SAMPLE).catch(() => []),
  );
  await Promise.race([Promise.all(loads), new Promise((r) => window.setTimeout(r, 2000))]);
}

const setState = (state: TermState, error: string | null = null) => useTerm.getState().set({ state, error });

function write(data: string): void {
  if (!cur || useTerm.getState().state !== 'live') return;
  void invoke('term.write', { tabId: cur.tabId, data });
}

/** keys typed into the terminal (direct mode) or sent by the key row; Ctrl from the key row applies once */
function input(data: string): void {
  const t = useTerm.getState();
  if (t.ctrl && data.length === 1) {
    t.set({ ctrl: false });
    const c = ctrlChar(data);
    if (c) return write(c);
  }
  write(data);
}

export function pressKey(id: KeyId): void {
  const t = useTerm.getState();
  if (id === 'ctrl') return t.set({ ctrl: !t.ctrl });
  if (t.ctrl) t.set({ ctrl: false });
  write(keySeq(id, cur?.term.modes.applicationCursorKeysMode ?? false));
}

/** A typed character while Ctrl is armed: sent as a control key instead of going into the input field. */
export function ctrlFromField(ch: string): boolean {
  const t = useTerm.getState();
  if (!t.ctrl) return false;
  t.set({ ctrl: false });
  const c = ctrlChar(ch);
  if (c) write(c);
  return true;
}

/** The input field's text, sent whole and followed by Enter. */
export function sendText(text: string): void {
  if (!cur || !text) return;
  write(pasteSeq(text, cur.term.modes.bracketedPasteMode));
  write('\r');
}

/** A path on the VM after an upload, typed into the terminal (direct mode; otherwise it goes into the field). */
export function typePath(path: string): void {
  write(path + ' ');
}

/** keys as typed: the answer digits of a permission prompt select the option without Enter */
export function typeRaw(data: string): void {
  write(data);
}

export function setDirect(direct: boolean): void {
  useTerm.getState().set({ direct });
  const ta = cur?.term.textarea;
  if (!ta) return;
  // without inputmode=none a tap on the terminal would open the keyboard over the input field
  if (direct) {
    ta.removeAttribute('inputmode');
    cur?.term.focus();
  } else {
    ta.setAttribute('inputmode', 'none');
    ta.blur();
  }
}

function ack(n: number): void {
  if (!cur) return;
  const c = cur;
  c.ackBytes += n;
  if (c.ackBytes >= ACK_BATCH) {
    void invoke('term.ack', { tabId: c.tabId, bytes: c.ackBytes });
    c.ackBytes = 0;
  } else if (!c.ackTimer) {
    c.ackTimer = window.setTimeout(() => {
      c.ackTimer = null;
      if (c.ackBytes) void invoke('term.ack', { tabId: c.tabId, bytes: c.ackBytes });
      c.ackBytes = 0;
    }, 30);
  }
}

/** rows of the tmux status line to cut off, and whether it is at the top */
function hiddenStatus(): { lines: number; top: boolean } {
  return useData.getState().hello?.tmuxStatus ?? { lines: 1, top: false };
}

/** Fit to the host; the tmux status line gets extra rows that fall outside the host and are clipped exactly. */
function fit(): { cols: number; rows: number } {
  if (!cur) return { cols: 80, rows: 24 };
  const { term, host } = cur;
  try {
    if (host.clientWidth > 20 && host.clientHeight > 20) {
      const d = cur.fit.proposeDimensions();
      const hide = hiddenStatus();
      if (d && Number.isFinite(d.cols) && Number.isFinite(d.rows)) {
        const rows = d.rows + hide.lines;
        if (d.cols !== term.cols || rows !== term.rows) term.resize(d.cols, rows);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cellH: number = (term as any)._core?._renderService?.dimensions?.css?.cell?.height ?? 0;
      const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
      if (screen) {
        const px = hide.lines * cellH;
        screen.style.clipPath = px ? (hide.top ? `inset(${px}px 0 0 0)` : `inset(0 0 ${px}px 0)`) : '';
        screen.style.marginTop = px && hide.top ? `${-px}px` : '';
      }
    }
  } catch {
    /* not laid out yet */
  }
  return { cols: Math.max(2, term.cols), rows: Math.max(2, term.rows) };
}

export async function openChannel(): Promise<void> {
  const c = cur;
  if (!c || c.opening) return;
  if (useConn.getState().state.kind !== 'online') return setState('offline');
  c.opening = true;
  setState('connecting');
  c.term.reset();
  const { cols, rows } = fit();
  try {
    const res = await Promise.race([
      invoke('term.open', { tabId: c.tabId, kind: 'tmux', session: c.session, cols, rows }),
      new Promise<{ ok: false; error: string }>((r) =>
        window.setTimeout(() => r({ ok: false, error: 'timeout' }), 10_000),
      ),
    ]);
    if (cur !== c) return;
    if (res.ok) {
      setState('live');
      void invoke('term.resize', { tabId: c.tabId, cols: c.term.cols, rows: c.term.rows });
    } else {
      if (res.error === 'timeout') void invoke('term.close', { tabId: c.tabId });
      setState('error', res.error === 'timeout' ? 'нет ответа за 10 с' : res.error);
    }
  } finally {
    c.opening = false;
  }
}

async function onExit(): Promise<void> {
  if (useConn.getState().state.kind !== 'online') return setState('offline');
  try {
    const { sessions } = await agent('list_active');
    setState(sessions.some((s) => s.name === cur?.session) ? 'detached' : 'ended');
  } catch {
    setState('offline');
  }
}

function openLink(uri: string): void {
  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(uri))
    return useApp.getState().toast(m.chat.noPorts);
  void invoke('launch.openExternal', { url: uri });
}

/** Attach a terminal for `session` to `host`; returns the cleanup that closes the channel (the session stays). */
export function mountTerminal(host: HTMLElement, session: string): () => void {
  const term = new Terminal({
    ...options(),
    allowProposedApi: true,
    scrollback: 1000,
    cursorBlink: false,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 1,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  const uni = new Unicode11Addon();
  term.loadAddon(uni);
  term.unicode.activeVersion = '11';
  term.loadAddon(new WebLinksAddon((_e, uri) => openLink(uri)));
  const c: Current = {
    tabId: `m${Math.random().toString(36).slice(2, 10)}`,
    session,
    term,
    fit: fitAddon,
    host,
    ackBytes: 0,
    ackTimer: null,
    opening: false,
    dispose: [],
  };
  cur = c;
  useTerm.getState().set({ state: 'connecting', error: null, ctrl: false });
  term.open(host);
  setDirect(useTerm.getState().direct);
  term.onData((d) => input(d));
  term.onBinary((d) => input(d));
  term.onResize(({ cols, rows }) => {
    if (useTerm.getState().state === 'live') void invoke('term.resize', { tabId: c.tabId, cols, rows });
  });
  c.dispose.push(
    on('term.data', ({ tabId, data }) => {
      if (tabId !== c.tabId) return;
      const n = data.byteLength;
      term.write(data, () => ack(n));
    }),
    on('term.exit', ({ tabId }) => {
      if (tabId === c.tabId && cur === c) void onExit();
    }),
  );
  let timer = 0;
  const ro = new ResizeObserver(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(fit, 80);
  });
  ro.observe(host);
  c.dispose.push(() => ro.disconnect());
  // offline -> overlay; back online and the first session list arrived -> attach again
  c.dispose.push(
    useConn.subscribe((s, p) => {
      if (p.state.kind === 'online' && s.state.kind !== 'online') setState('offline');
    }),
    useData.subscribe((d, p) => {
      if (d.sessionsSynced && !p.sessionsSynced && useTerm.getState().state === 'offline') void openChannel();
      if (JSON.stringify(d.hello?.tmuxStatus) !== JSON.stringify(p.hello?.tmuxStatus)) fit();
    }),
    useApp.subscribe((s, p) => {
      if (s.dark !== p.dark) term.options.theme = terminalTheme(s.dark);
      if (s.settings?.appearance.fontSize !== p.settings?.appearance.fontSize) {
        term.options.fontSize = options().fontSize;
        fit();
      }
    }),
  );
  void loadTermFont().then(() => {
    if (cur !== c) return;
    fit();
    void openChannel();
  });
  return () => {
    window.clearTimeout(timer);
    for (const d of c.dispose) d();
    if (c.ackTimer) window.clearTimeout(c.ackTimer);
    void invoke('term.close', { tabId: c.tabId });
    term.dispose();
    if (cur === c) cur = null;
  };
}
