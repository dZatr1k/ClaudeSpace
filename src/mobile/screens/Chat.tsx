// A chat: the header carries the chat's title and Claude's status, «Прервать» while Claude works and «⋯» for the rest;
// the terminal fills the screen; the input field sits at the bottom, so the keyboard pushes it up. A menu Claude Code
// shows (a permission prompt, a question) becomes answer buttons above the field. The key row and direct typing are
// switches in «⋯»: text goes to Claude Code whole from the field, typing straight into the terminal breaks on Android
// keyboards (autocorrect, composition). A swipe on the terminal scrolls the history.
import {
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Paperclip,
  SendHorizontal,
  Square,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { CLAUDE_MODELS } from '@shared/protocol';
import type { ClaudeProc, Session } from '@shared/model';
import { StatusIcon } from '../../renderer/components/ui/StatusIcon';
import { t } from '../../renderer/i18n/ru';
import { claudeUi, isUnknownStatus, primaryClaude, statusLine } from '../../renderer/lib/status';
import { useData } from '../../renderer/stores/data';
import { sessionTitle } from '../actions';
import { agent, invoke } from '../bridge';
import { useNow } from '../hooks';
import { KEY_ROW } from '../keys';
import { m } from '../strings';
import { back, useApp } from '../store';
import {
  ctrlFromField,
  mountTerminal,
  openChannel,
  pressKey,
  sendText,
  setDirect,
  setKeys,
  toBottom,
  typePath,
  typeRaw,
  useTerm,
} from '../terminal';
import { Button, IconButton, Sheet, SheetItem } from '../ui';

const canInterrupt = (c: ClaudeProc | null) => c?.status === 'busy' || c?.status === 'waiting';
const canCommand = (c: ClaudeProc | null) => c?.status === 'idle';

async function send(params: Parameters<typeof agent<'claude_send'>>[1]): Promise<void> {
  const app = useApp.getState();
  try {
    const r = await agent('claude_send', params);
    if (r.stashed) app.toast(t.claudeBar.stashed);
  } catch (e) {
    app.toast(t.claudeBar.failed((e as Error).message), 'error');
  }
}

function TermOverlay() {
  const state = useTerm((s) => s.state);
  const error = useTerm((s) => s.error);
  if (state === 'live') return null;
  const text =
    state === 'connecting'
      ? m.chat.connecting
      : state === 'offline'
        ? m.chat.offline
        : state === 'detached'
          ? m.chat.detached
          : state === 'ended'
            ? m.chat.ended
            : m.chat.error(error ?? '');
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-base/85 px-8 text-center"
      role="status"
      data-testid="term-overlay"
    >
      <p className="text-[15px] leading-snug">{text}</p>
      {(state === 'detached' || state === 'error') && (
        <Button kind="primary" onClick={() => void openChannel()}>
          {state === 'detached' ? m.chat.reattach : m.retry}
        </Button>
      )}
      {state === 'ended' && <Button onClick={back}>{m.chat.back}</Button>}
    </div>
  );
}

/** back to the live screen after scrolling the history */
function ToBottom() {
  const scrolled = useTerm((s) => s.scrolled);
  if (!scrolled) return null;
  return (
    <button
      type="button"
      onClick={() => void toBottom()}
      className="anim-rise absolute bottom-3 right-3 flex min-h-11 items-center gap-2 rounded-[10px] border border-line-strong bg-elevated px-4 text-[14px] shadow-pop active:bg-selected"
    >
      <ArrowDown size={16} aria-hidden /> {m.chat.toBottom}
    </button>
  );
}

/** The menu on screen as buttons with its own wording; a digit picks the option in Claude Code, without Enter. */
function Answers() {
  const menu = useTerm((s) => s.menu);
  const live = useTerm((s) => s.state === 'live');
  if (!live || !menu.length) return null;
  return (
    <div
      role="group"
      aria-label={m.chat.answers}
      className="max-h-[40dvh] shrink-0 overflow-y-auto border-t border-line bg-surface py-1"
      data-testid="answers"
    >
      {menu.map((o) => (
        <button
          key={o.n}
          type="button"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => typeRaw(String(o.n))}
          className="flex min-h-11 w-full items-center gap-3 px-4 py-1.5 text-left active:bg-selected"
        >
          <span
            className={`tnum flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] border text-[14px] font-medium ${
              o.selected ? 'border-st-waiting text-st-waiting' : 'border-line-strong text-muted'
            }`}
            aria-hidden
          >
            {o.n}
          </span>
          <span
            className={`min-w-0 flex-1 text-[15px] leading-snug ${o.selected ? 'text-fg' : 'text-muted'}`}
          >
            {o.label}
          </span>
        </button>
      ))}
    </div>
  );
}

function KeyRow() {
  const ctrl = useTerm((s) => s.ctrl);
  const key =
    'flex h-11 min-w-0 flex-1 items-center justify-center rounded-[6px] text-[14px] active:bg-selected';
  return (
    <div
      className="flex shrink-0 gap-0.5 border-t border-line bg-surface px-1 py-1"
      role="group"
      aria-label={m.chat.keys}
    >
      {KEY_ROW.map((k) => (
        <button
          key={k.id}
          type="button"
          aria-label={k.name}
          aria-pressed={k.id === 'ctrl' ? ctrl : undefined}
          title={k.id === 'ctrl' && ctrl ? m.chat.ctrlArmed : k.name}
          className={`${key} ${k.id === 'ctrl' && ctrl ? 'bg-accent-soft font-semibold text-accent-text' : 'text-fg'}`}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => pressKey(k.id)}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}

function Composer() {
  const [text, setText] = useState('');
  const direct = useTerm((s) => s.direct);
  const live = useTerm((s) => s.state === 'live');
  const file = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  // grow with the text up to five lines
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 5 * 22 + 20)}px`;
  }, [text]);

  const submit = () => {
    if (!text.trim()) return;
    sendText(text);
    setText('');
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    const app = useApp.getState();
    for (const f of files) {
      const timer = window.setTimeout(() => app.toast(m.chat.uploading), 600);
      try {
        const r = await invoke('attach.upload', {
          name: f.name,
          data: new Uint8Array(await f.arrayBuffer()),
        });
        if (!r.ok) {
          app.toast(m.chat.attachFailed(r.error), 'error');
          continue;
        }
        if (useTerm.getState().direct) typePath(r.path);
        else setText((s) => (s && !s.endsWith(' ') ? `${s} ` : s) + r.path + ' ');
      } catch (err) {
        app.toast(m.chat.attachFailed((err as Error).message), 'error');
      } finally {
        window.clearTimeout(timer);
      }
    }
  };

  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // a hardware keyboard: Enter sends, Shift+Enter is a new line
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex shrink-0 items-end gap-1 border-t border-line bg-surface px-1 pb-1.5 pt-3">
      <input
        ref={file}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void onFile(e)}
        data-testid="attach-input"
      />
      <IconButton label={m.chat.attach} disabled={!live} onClick={() => file.current?.click()}>
        <Paperclip size={20} strokeWidth={1.75} aria-hidden />
      </IconButton>
      {direct ? (
        <div className="flex min-h-11 flex-1 items-center gap-2 pl-1">
          <span className="min-w-0 flex-1 text-[14px] text-muted">{m.chat.directOn}</span>
          <Button kind="quiet" className="min-h-11 px-3" onClick={() => setDirect(false)}>
            {m.chat.directOff}
          </Button>
        </div>
      ) : (
        <>
          {/* the label sits on the field's border: always visible (R-39), yet it costs no extra row */}
          <div className="relative min-w-0 flex-1">
            <label
              htmlFor="composer"
              className="pointer-events-none absolute -top-2 left-2 bg-surface px-1 text-[11px] leading-4 text-muted"
            >
              {m.chat.placeholder}
            </label>
            <textarea
              id="composer"
              ref={area}
              rows={1}
              value={text}
              className="block min-h-11 w-full resize-none rounded-[6px] border border-control bg-base px-3 py-2.5 text-[16px] leading-[22px] text-fg outline-none focus:border-accent"
              onKeyDown={onKey}
              onChange={(e) => {
                // Ctrl from the key row: the one letter just typed goes to the terminal with Ctrl instead. Read from
                // the change, not from key events: Android keyboards rarely send those while composing
                const v = e.target.value;
                if (useTerm.getState().ctrl && v.length === text.length + 1) {
                  const at = Math.max(0, (e.target.selectionStart ?? v.length) - 1);
                  const typed = v[at] as string;
                  if (v.slice(0, at) + v.slice(at + 1) === text && ctrlFromField(typed)) return;
                }
                setText(v);
              }}
              data-testid="composer"
            />
          </div>
          <IconButton
            label={m.chat.send}
            disabled={!live || !text.trim()}
            className="bg-accent text-accent-fg disabled:bg-transparent disabled:text-faint"
            onClick={submit}
          >
            <SendHorizontal size={20} strokeWidth={1.75} aria-hidden />
          </IconButton>
        </>
      )}
    </div>
  );
}

function SwitchItem({
  on,
  onClick,
  children,
  hint,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left active:bg-selected"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[15px]">{children}</span>
        {hint && <span className="block text-[13px] text-muted">{hint}</span>}
      </span>
      <span
        aria-hidden
        className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors duration-100 ${on ? 'border-accent bg-accent' : 'border-control bg-base'}`}
      >
        <span
          className={`absolute top-[3px] h-5 w-5 rounded-full transition-[left] duration-100 ${on ? 'left-[24px] bg-accent-fg' : 'left-[3px] bg-muted'}`}
        />
      </span>
    </button>
  );
}

/** «⋯»: the terminal switches, then Claude's commands (only while it is idle: Enter at a permission prompt would
 * approve it). The models open as their own list, so the sheet stays short. */
function ChatSheet({ c }: { c: ClaudeProc | null }) {
  const close = () => useApp.getState().set({ sheet: null });
  const keys = useTerm((s) => s.keys);
  const direct = useTerm((s) => s.direct);
  const [models, setModels] = useState(false);
  const idle = canCommand(c);
  if (models && c)
    return (
      <Sheet title={t.claudeBar.model} onClose={close}>
        <SheetItem onClick={() => setModels(false)}>
          <span className="flex items-center gap-2 text-muted">
            <ChevronLeft size={18} aria-hidden /> {m.chat.commands}
          </span>
        </SheetItem>
        {CLAUDE_MODELS.map((model) => (
          <SheetItem
            key={model}
            disabled={!idle}
            hint={`/model ${model}`}
            onClick={() => {
              close();
              void send({ chatId: c.chatId, action: 'model', model });
            }}
          >
            {t.claudeBar.models[model] ?? model}
          </SheetItem>
        ))}
      </Sheet>
    );
  return (
    <Sheet title={m.chat.commands} onClose={close}>
      <SwitchItem on={keys} onClick={() => setKeys(!keys)} hint={m.chat.keysHint}>
        {m.chat.keys}
      </SwitchItem>
      <SwitchItem
        on={direct}
        onClick={() => {
          close();
          setDirect(!direct);
        }}
        hint={m.chat.directHint}
      >
        {m.chat.direct}
      </SwitchItem>
      {c && (
        <>
          <div className="px-4 pb-1 pt-3 text-[13px] font-semibold text-muted">Claude</div>
          {!idle && <p className="px-4 pb-2 text-[14px] text-muted">{t.claudeBar.busy}</p>}
          <SheetItem
            disabled={!idle}
            hint="/compact"
            onClick={() => {
              close();
              void send({ chatId: c.chatId, action: 'compact' });
            }}
          >
            {t.claudeBar.compact}
          </SheetItem>
          <SheetItem
            disabled={!idle}
            hint="/clear"
            onClick={() => {
              close();
              useApp.getState().set({
                dialog: {
                  title: t.claudeBar.clearTitle,
                  body: t.claudeBar.clearBody,
                  confirm: t.claudeBar.clear,
                  onConfirm: () => void send({ chatId: c.chatId, action: 'clear' }),
                },
              });
            }}
          >
            {t.claudeBar.clear}
          </SheetItem>
          <SheetItem disabled={!idle} hint="/model" onClick={() => setModels(true)}>
            <span className="flex items-center justify-between gap-2">
              {t.claudeBar.model}
              <ChevronRight size={18} className="text-faint" aria-hidden />
            </span>
          </SheetItem>
        </>
      )}
    </Sheet>
  );
}

function Status({ c, session }: { c: ClaudeProc | null; session: string }) {
  const now = useNow(15_000);
  if (!c) return <p className="mono truncate text-muted">{session}</p>;
  return (
    <p
      className="flex items-center gap-1.5 text-[13px] text-muted"
      aria-live="polite"
      data-testid="chat-status"
    >
      <StatusIcon status={claudeUi(c.status)} size={13} unknown={isUnknownStatus(c.status)} />
      <span className="tnum truncate">{statusLine(c.status, c.statusAt, now)}</span>
    </p>
  );
}

export function Chat({ session, chatId }: { session: string; chatId: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const sessions = useData((d) => d.sessions);
  const chats = useData((d) => d.chats);
  const sheet = useApp((s) => s.sheet);
  const keys = useTerm((x) => x.keys);
  const direct = useTerm((x) => x.direct);
  const live = useTerm((x) => x.state === 'live');
  const s: Session | undefined = sessions.find((x) => x.name === session);
  const c = s ? primaryClaude(s) : null;
  const title = s ? sessionTitle(s) : (chatId && chats[chatId]?.title) || session;

  useEffect(() => {
    if (!host.current) return;
    return mountTerminal(host.current, session);
  }, [session]);

  return (
    <div className="safe flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-line bg-surface pr-1">
        <IconButton label={m.chat.back} onClick={back}>
          <ChevronLeft size={24} strokeWidth={1.75} aria-hidden />
        </IconButton>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[16px] font-semibold">{title}</h1>
          <Status c={live ? c : null} session={session} />
        </div>
        {live && canInterrupt(c) && c && (
          <Button
            className="min-h-11 px-3 text-[14px]"
            onClick={() => void send({ chatId: c.chatId, action: 'interrupt' })}
          >
            <Square size={14} aria-hidden /> {t.claudeBar.interrupt}
          </Button>
        )}
        <IconButton label={m.chat.commands} onClick={() => useApp.getState().set({ sheet: 'commands' })}>
          <Ellipsis size={22} strokeWidth={1.75} aria-hidden />
        </IconButton>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-base">
        <div ref={host} className="absolute inset-0" data-testid="terminal" />
        <TermOverlay />
        <ToBottom />
      </div>
      <Answers />
      {(keys || direct) && <KeyRow />}
      <Composer />
      {sheet === 'commands' && <ChatSheet c={live ? c : null} />}
    </div>
  );
}
