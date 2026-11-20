// Everything before the lists: first setup, the server key check, a key the VM rejects, an agent that cannot start,
// and the connection steps. A spacious screen with the large ◆, the rhythm break DESIGN §5 gives the connect screen.
import { Check, LoaderCircle, TriangleAlert, WifiOff } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { ConnState, ConnStep } from '@shared/model';
import { invoke } from '../bridge';
import { useNow } from '../hooks';
import { m } from '../strings';
import { useApp } from '../store';
import { Button, KeyBlock, copy } from '../ui';

function Frame({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <main className="safe h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-lg flex-col px-6 pb-10 pt-12">
        <div className="flex items-start gap-3">
          {/* the mark sits on the first line of a title that wraps */}
          <span className="flex h-[28px] shrink-0 items-center">
            {icon ?? <span className="diamond text-[22px]" aria-hidden />}
          </span>
          <h1 className="text-[22px] font-semibold leading-[28px] tracking-[-0.01em]">{title}</h1>
        </div>
        {children}
      </div>
    </main>
  );
}

const field =
  'mt-1 block h-12 w-full rounded-[4px] border border-control bg-base px-3 text-[16px] text-fg outline-none focus:border-accent';

export function SetupForm({
  onDone,
  submit: submitLabel = m.setup.connect,
  className = 'mt-6',
}: {
  onDone?: () => void;
  submit?: string;
  className?: string;
}) {
  const settings = useApp((s) => s.settings);
  const [host, setHost] = useState(settings?.connection.host ?? '');
  const [port, setPort] = useState(String(settings?.connection.port ?? 22));
  const [user, setUser] = useState(settings?.connection.user ?? '');
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = Number(port);
    if (!host.trim() || !user.trim()) return setError(m.setup.invalid);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return setError(m.setup.badPort);
    setError(null);
    void invoke('settings.set', { connection: { host: host.trim(), port: p, user: user.trim() } }).then(
      (s) => {
        useApp.getState().set({ settings: s });
        onDone?.();
      },
    );
  };
  return (
    <form
      onSubmit={submit}
      onChange={() => error && setError(null)}
      noValidate
      className={`${className} flex flex-col gap-4`}
      aria-describedby={error ? 'setup-error' : undefined}
    >
      <div className="grid grid-cols-[1fr_6rem] gap-3">
        <label className="block text-[14px] text-muted">
          {m.setup.host}
          <input
            className={field}
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder={m.setup.hostPlaceholder}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
            name="host"
          />
        </label>
        <label className="block text-[14px] text-muted">
          {m.setup.port}
          <input
            className={`${field} tnum`}
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
            inputMode="numeric"
            name="port"
          />
        </label>
      </div>
      <label className="block text-[14px] text-muted">
        {m.setup.user}
        <input
          className={field}
          value={user}
          onChange={(e) => setUser(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          name="user"
        />
      </label>
      {error && (
        <p id="setup-error" role="alert" className="text-[14px] text-st-error">
          {error}
        </p>
      )}
      <Button kind="primary" type="submit">
        {submitLabel}
      </Button>
    </form>
  );
}

const STEPS: ConnStep[] = ['config', 'auth', 'hostkey', 'agent'];

function Steps({ state }: { state: Extract<ConnState, { kind: 'connecting' }> }) {
  const at = STEPS.indexOf(state.step);
  return (
    <ol className="mt-8 flex flex-col gap-3" aria-label={m.conn.connectingTitle}>
      {STEPS.map((s, i) => (
        <li
          key={s}
          className="flex items-center gap-3 text-[15px]"
          aria-current={i === at ? 'step' : undefined}
        >
          {i < at ? (
            <Check size={18} className="anim-pop text-st-idle" aria-hidden />
          ) : i === at ? (
            <LoaderCircle size={18} className="anim-spin text-st-busy" aria-hidden />
          ) : (
            <span className="h-[18px] w-[18px] rounded-full border border-line-strong" aria-hidden />
          )}
          <span className={i > at ? 'text-muted' : ''}>{m.conn.steps[s]}</span>
        </li>
      ))}
      {state.detail && <li className="pl-[30px] text-[14px] text-muted">{state.detail}</li>}
    </ol>
  );
}

function Countdown({ at }: { at: number }) {
  const now = useNow();
  return <>{m.conn.retryIn(Math.max(0, Math.ceil((at - now) / 1000)))}</>;
}

export function ConnScreen({ state }: { state: ConnState }) {
  const settings = useApp((s) => s.settings);
  const [editing, setEditing] = useState(false);
  const retry = () => void invoke('conn.retryNow');
  const edit = (
    <Button kind="quiet" onClick={() => setEditing(true)}>
      {m.hostkey.edit}
    </Button>
  );

  if (editing || !settings?.connection.host || (state.kind === 'needs-user' && state.reason === 'config'))
    return (
      <Frame title={m.setup.title}>
        <p className="mt-3 text-[15px] leading-snug text-muted">{m.setup.lead}</p>
        <SetupForm onDone={() => setEditing(false)} />
        <div className="mt-8">
          <KeyBlock />
        </div>
      </Frame>
    );

  if (state.kind === 'needs-user' && state.reason === 'hostkey-new')
    return (
      <Frame title={m.hostkey.newTitle}>
        <p className="mt-3 text-[15px] leading-snug text-muted">{m.hostkey.newBody(state.host ?? '')}</p>
        <button
          type="button"
          className="mono mt-3 rounded-[4px] bg-surface p-3 text-left text-muted active:bg-selected"
          onClick={() => void copy(m.hostkey.command)}
          aria-label={`${m.key.copyCommand}: ${m.hostkey.command}`}
        >
          {m.hostkey.command}
        </button>
        <p
          className="mono mt-4 break-all rounded-[4px] border border-line-strong p-3 text-[15px] text-fg"
          data-testid="host-fingerprint"
        >
          {state.fingerprint}
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <Button kind="primary" onClick={() => void invoke('conn.trustHost', { accept: true })}>
            {m.hostkey.trust}
          </Button>
          {edit}
        </div>
      </Frame>
    );

  if (state.kind === 'needs-user' && state.reason === 'hostkey-mismatch')
    return (
      <Frame
        title={m.hostkey.mismatchTitle}
        icon={<TriangleAlert size={24} className="text-st-error" aria-hidden />}
      >
        <p className="mt-3 text-[15px] leading-snug">{m.hostkey.mismatchBody(state.host ?? '')}</p>
        <p className="mono mt-4 break-all rounded-[4px] border border-st-error p-3 text-[15px]">
          {state.fingerprint}
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <Button
            onClick={() =>
              useApp.getState().set({
                dialog: {
                  title: m.hostkey.forgetTitle,
                  body: m.hostkey.forgetBody,
                  confirm: m.hostkey.forgetConfirm,
                  danger: true,
                  onConfirm: () => void invoke('conn.forgetHost').then(retry),
                },
              })
            }
          >
            {m.hostkey.forget}
          </Button>
          {edit}
        </div>
      </Frame>
    );

  if (state.kind === 'needs-user' && state.reason === 'auth-rejected')
    return (
      <Frame title={m.auth.title} icon={<TriangleAlert size={24} className="text-st-waiting" aria-hidden />}>
        <p className="mt-3 text-[15px] leading-snug text-muted">{m.auth.body}</p>
        <div className="mt-5">
          <KeyBlock />
        </div>
        <div className="mt-6 flex flex-col gap-2">
          <Button kind="primary" onClick={retry}>
            {m.retry}
          </Button>
          {edit}
        </div>
      </Frame>
    );

  if (state.kind === 'needs-user')
    return (
      <Frame title={m.deps.title} icon={<TriangleAlert size={24} className="text-st-waiting" aria-hidden />}>
        <p className="mt-3 text-[15px] leading-snug">{state.detail}</p>
        <div className="mt-6 flex flex-col gap-2">
          <Button kind="primary" onClick={retry}>
            {m.retry}
          </Button>
          {edit}
        </div>
      </Frame>
    );

  if (state.kind === 'offline')
    return (
      <Frame title={m.conn.offlineTitle} icon={<WifiOff size={24} className="text-st-offline" aria-hidden />}>
        <p className="mt-3 break-words text-[15px] leading-snug text-muted">{state.error}</p>
        <p className="tnum mt-2 text-[14px] text-muted">
          <Countdown at={state.retryAt} />
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <Button kind="primary" onClick={retry}>
            {m.conn.retryNow}
          </Button>
          {edit}
        </div>
      </Frame>
    );

  return (
    <Frame title={m.conn.connectingTitle}>
      <p className="mono mt-2 text-muted">
        {settings.connection.user}@{settings.connection.host}
        {settings.connection.port !== 22 ? `:${settings.connection.port}` : ''}
      </p>
      {state.kind === 'connecting' ? (
        <Steps state={state} />
      ) : (
        <Steps state={{ kind: 'connecting', step: 'config', attempt: 0 }} />
      )}
    </Frame>
  );
}

export function NoBridge() {
  return (
    <Frame title={m.noBridge.title}>
      <p className="mt-3 text-[15px] leading-snug text-muted">{m.noBridge.body}</p>
      <p className="mt-6 text-[14px] text-muted">{m.settings.version(__APP_VERSION__)}</p>
    </Frame>
  );
}

export { Countdown };
