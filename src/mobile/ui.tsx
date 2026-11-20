// Building blocks of the phone screens. Sizes follow the phone, not the desktop: every target is 44 px or more,
// text 15 px; colours, radii and shadows are the desktop tokens (DESIGN §5).
import { Check, Copy, WifiOff, TriangleAlert } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { ConnState } from '@shared/model';
import { m } from './strings';
import { useApp } from './store';

const base =
  'inline-flex min-h-12 items-center justify-center gap-2 rounded-[6px] px-4 text-[15px] font-medium transition-colors duration-100 disabled:opacity-45';

export function Button({
  kind = 'secondary',
  className = '',
  ...p
}: React.ComponentProps<'button'> & { kind?: 'primary' | 'secondary' | 'danger' | 'quiet' }) {
  const look =
    kind === 'primary'
      ? 'bg-accent text-accent-fg active:brightness-90'
      : kind === 'danger'
        ? 'bg-st-error text-st-error-fg active:brightness-90'
        : kind === 'quiet'
          ? 'text-accent-text active:bg-selected'
          : 'border border-control text-fg active:bg-selected';
  return <button type="button" className={`${base} ${look} ${className}`} {...p} />;
}

export function IconButton({
  label,
  className = '',
  children,
  ...p
}: React.ComponentProps<'button'> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[6px] text-muted transition-colors duration-100 active:bg-selected aria-pressed:bg-selected aria-pressed:text-fg ${className}`}
      {...p}
    >
      {children}
    </button>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-4 pb-1 pt-5">
      <h2 className="text-[13px] font-semibold text-muted">{children}</h2>
      {aside}
    </div>
  );
}

export async function copy(text: string): Promise<void> {
  const app = useApp.getState();
  try {
    await navigator.clipboard.writeText(text);
    app.toast(m.key.copied, 'success', 2000);
  } catch {
    app.toast(m.key.copyFailed, 'error');
  }
}

/** The phone's public key with the two ways to put it on the VM. */
export function KeyBlock() {
  const key = useApp((s) => s.key);
  if (!key) return null;
  const command = `mkdir -p ~/.ssh && echo '${key.publicKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
  return (
    <section aria-labelledby="key-title" className="rounded-[10px] border border-line-strong bg-surface p-4">
      <h2 id="key-title" className="text-[15px] font-semibold">
        {m.key.title}
      </h2>
      <p className="mt-1 text-[14px] leading-snug text-muted">{m.key.hint}</p>
      <p
        className="mono mt-3 select-all break-all rounded-[4px] bg-base p-3 leading-relaxed"
        data-testid="phone-key"
      >
        {key.publicKey}
      </p>
      <p className="mt-2 break-all text-[13px] text-muted">
        {m.key.fingerprint} <span className="mono text-fg">{key.fingerprint}</span>
      </p>
      <div className="mt-3 flex flex-col gap-2">
        <Button onClick={() => void copy(key.publicKey)}>
          <Copy size={16} aria-hidden /> {m.key.copyKey}
        </Button>
        <Button onClick={() => void copy(command)} title={m.key.commandHint}>
          <Copy size={16} aria-hidden /> {m.key.copyCommand}
        </Button>
      </div>
    </section>
  );
}

/** Connection in one word with a shape (DESIGN §5.2: never colour alone). */
export function ConnBadge({ state }: { state: ConnState }) {
  const online = state.kind === 'online';
  const busy = state.kind === 'connecting';
  const label = online ? m.conn.online : busy ? m.conn.connecting : m.conn.offline;
  return (
    <span className="flex items-center gap-1.5 text-[13px] text-muted" role="status" data-testid="conn-badge">
      {online ? (
        <span className="h-2 w-2 rounded-full bg-st-idle" aria-hidden />
      ) : busy ? (
        <span className="anim-pulse-loop h-2 w-2 rounded-full border border-st-busy" aria-hidden />
      ) : state.kind === 'needs-user' ? (
        <TriangleAlert size={14} className="text-st-waiting" aria-hidden />
      ) : (
        <WifiOff size={14} className="text-st-offline" aria-hidden />
      )}
      {label}
    </span>
  );
}

/** Bottom sheet: closes with the back button, a tap outside or Esc. */
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-40 flex flex-col justify-end"
      style={{ background: 'var(--scrim)' }}
      onClick={onClose}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="safe anim-rise max-h-[80dvh] overflow-y-auto rounded-t-[10px] bg-elevated shadow-modal outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 pb-2 pt-4 text-[15px] font-semibold">{title}</div>
        <div className="pb-2">{children}</div>
      </div>
    </div>
  );
}

export function SheetItem({
  children,
  onClick,
  disabled,
  hint,
  selected,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  hint?: ReactNode;
  selected?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left active:bg-selected disabled:opacity-45"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px]">{children}</span>
        {hint && <span className="block truncate text-[13px] text-muted">{hint}</span>}
      </span>
      {selected && <Check size={18} className="text-accent-text" aria-hidden />}
    </button>
  );
}

export function ConfirmDialog() {
  const d = useApp((s) => s.dialog);
  const set = useApp((s) => s.set);
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!d) return;
    ok.current?.focus();
    const k = (e: KeyboardEvent) => e.key === 'Escape' && set({ dialog: null });
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [d, set]);
  if (!d) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'var(--scrim)' }}
      onClick={() => set({ dialog: null })}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dlg-title"
        aria-describedby="dlg-body"
        className="anim-rise w-full max-w-sm rounded-[10px] bg-elevated p-5 shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="dlg-title" className="text-[17px] font-semibold">
          {d.title}
        </h2>
        <p id="dlg-body" className="mt-2 text-[15px] leading-snug text-muted">
          {d.body}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button kind="quiet" onClick={() => set({ dialog: null })}>
            {m.cancel}
          </Button>
          <Button
            ref={ok}
            kind={d.danger ? 'danger' : 'primary'}
            onClick={() => {
              set({ dialog: null });
              d.onConfirm();
            }}
          >
            {d.confirm}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismiss);
  if (!toasts.length) return null;
  return (
    <div
      className="safe pointer-events-none fixed inset-x-0 top-16 z-50 flex flex-col items-center gap-2 px-4"
      aria-live="polite"
    >
      {toasts.map((x) => (
        <button
          key={x.id}
          type="button"
          onClick={() => {
            dismiss(x.id);
            x.action?.();
          }}
          className={`anim-rise pointer-events-auto max-w-md rounded-[10px] bg-elevated px-4 py-3 text-left text-[14px] leading-snug shadow-pop ${
            x.tone === 'error' ? 'border border-st-error' : 'border border-line-strong'
          }`}
        >
          {x.text}
        </button>
      ))}
    </div>
  );
}
