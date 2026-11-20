// A chat: the terminal of its tmux session full screen, then the Claude strip, the key row and the input field at the
// bottom, so the keyboard pushes them up together. Text is typed in the field and goes to Claude Code whole: typing
// straight into the terminal breaks on Android keyboards (autocorrect, composition), so that is a switch.
import { ChevronLeft, Ellipsis, Keyboard, Paperclip, SendHorizontal, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
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

function TermOverlay({ session }: { session: string }) {
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
      <span className="sr-only">{session}</span>
    </div>
  );
}

function ClaudeStrip({ c }: { c: ClaudeProc }) {
  const now = useNow(15_000);
  return (
    <div
      className="flex min-h-13 shrink-0 items-center gap-1 border-t border-line bg-surface py-1 pl-4 pr-1"
      role="toolbar"
      aria-label={t.claudeBar.label}
      data-testid="claude-strip"
    >
      <StatusIcon status={claudeUi(c.status)} size={16} unknown={isUnknownStatus(c.status)} />
      <span className="tnum min-w-0 flex-1 truncate pl-1 text-[14px] text-muted" aria-live="polite">
        {statusLine(c.status, c.statusAt, now)}
      </span>
      {canInterrupt(c) && (
        <Button
          className="min-h-11 px-3"
          onClick={() => void send({ chatId: c.chatId, action: 'interrupt' })}
        >
          <Square size={14} aria-hidden /> {t.claudeBar.interrupt}
        </Button>
      )}
      <IconButton label={m.chat.commands} onClick={() => useApp.getState().set({ sheet: 'commands' })}>
        <Ellipsis size={22} strokeWidth={1.75} aria-hidden />
      </IconButton>
    </div>
  );
}

function CommandsSheet({ c }: { c: ClaudeProc | null }) {
  const close = () => useApp.getState().set({ sheet: null });
  const idle = canCommand(c);
  const hint = idle ? undefined : t.claudeBar.busy;
  return (
    <Sheet title={m.chat.commands} onClose={close}>
      {!idle && <p className="px-4 pb-2 text-[14px] text-muted">{hint}</p>}
      <SheetItem
        disabled={!idle || !c}
        hint="/compact"
        onClick={() => {
          close();
          if (c) void send({ chatId: c.chatId, action: 'compact' });
        }}
      >
        {t.claudeBar.compact}
      </SheetItem>
      <SheetItem
        disabled={!idle || !c}
        hint="/clear"
        onClick={() => {
          close();
          if (!c) return;
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
      <div className="px-4 pb-1 pt-3 text-[13px] font-semibold text-muted">{t.claudeBar.model}</div>
      {CLAUDE_MODELS.map((model) => (
        <SheetItem
          key={model}
          disabled={!idle || !c}
          hint={`/model ${model}`}
          onClick={() => {
            close();
            if (c) void send({ chatId: c.chatId, action: 'model', model });
          }}
        >
          {t.claudeBar.models[model] ?? model}
        </SheetItem>
      ))}
    </Sheet>
  );
}

function KeyRow({ waiting }: { waiting: boolean }) {
  const ctrl = useTerm((s) => s.ctrl);
  const key =
    'flex h-11 min-w-0 flex-1 items-center justify-center rounded-[6px] text-[14px] active:bg-selected';
  return (
    <div className="shrink-0 border-t border-line bg-surface px-1 py-1">
      {waiting && (
        <div className="mb-1 flex gap-1" role="group" aria-label={m.chat.answers}>
          {['1', '2', '3'].map((n) => (
            <button
              key={n}
              type="button"
              aria-label={m.chat.answer(Number(n))}
              className={`${key} tnum border border-st-waiting font-medium text-st-waiting`}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => typeRaw(n)}
            >
              {n}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-0.5" role="group" aria-label={m.chat.keys}>
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
      {!direct && (
        // the label sits on the field's border: always visible (R-39), yet it costs no extra row
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
              // Ctrl from the key row: the one letter just typed goes to the terminal with Ctrl instead. Read from the
              // change, not from key events: Android keyboards rarely send those while composing
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
      )}
      {direct && <span className="min-h-11 flex-1 px-2 py-3 text-[14px] text-muted">{m.chat.direct}</span>}
      <IconButton label={m.chat.direct} aria-pressed={direct} onClick={() => setDirect(!direct)}>
        <Keyboard size={20} strokeWidth={1.75} aria-hidden />
      </IconButton>
      {!direct && (
        <IconButton
          label={m.chat.send}
          disabled={!live || !text.trim()}
          className="bg-accent text-accent-fg disabled:bg-transparent disabled:text-faint"
          onClick={submit}
        >
          <SendHorizontal size={20} strokeWidth={1.75} aria-hidden />
        </IconButton>
      )}
    </div>
  );
}

export function Chat({ session, chatId }: { session: string; chatId: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const sessions = useData((d) => d.sessions);
  const chats = useData((d) => d.chats);
  const sheet = useApp((s) => s.sheet);
  const s: Session | undefined = sessions.find((x) => x.name === session);
  const c = s ? primaryClaude(s) : null;
  const title = s ? sessionTitle(s) : (chatId && chats[chatId]?.title) || session;
  const live = useTerm((x) => x.state === 'live');

  useEffect(() => {
    if (!host.current) return;
    return mountTerminal(host.current, session);
  }, [session]);

  return (
    <div className="safe flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-line bg-surface pr-3">
        <IconButton label={m.chat.back} onClick={back}>
          <ChevronLeft size={24} strokeWidth={1.75} aria-hidden />
        </IconButton>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[16px] font-semibold">{title}</h1>
          <p className="mono truncate text-muted">{session}</p>
        </div>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-base">
        <div ref={host} className="absolute inset-0" data-testid="terminal" />
        <TermOverlay session={session} />
      </div>
      {live && c && <ClaudeStrip c={c} />}
      <KeyRow waiting={live && c?.status === 'waiting'} />
      <Composer />
      {sheet === 'commands' && <CommandsSheet c={c} />}
    </div>
  );
}
