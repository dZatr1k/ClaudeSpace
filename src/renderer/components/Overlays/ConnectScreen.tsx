// Connection / first run screen (DESIGN §3.2): steps with state, explanations and actions.
import {
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  LoaderCircle,
  ShieldAlert,
  WifiOff,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ConnState, ConnStep } from '@shared/model';
import type { SshHostsInfo } from '@shared/ipc';
import { invoke } from '../../bridge';
import { t } from '../../i18n/ru';
import { useConn } from '../../stores/conn';
import { useUi } from '../../stores/ui';
import { Button } from '../ui/Button';

const STEPS: { id: ConnStep; label: string }[] = [
  { id: 'config', label: t.connect.stepConfig },
  { id: 'auth', label: t.connect.stepAuth },
  { id: 'hostkey', label: t.connect.stepHostkey },
  { id: 'agent', label: t.connect.stepAgent },
];

function failedStep(s: ConnState): ConnStep | null {
  if (s.kind !== 'needs-user') return null;
  switch (s.reason) {
    case 'config':
      return 'config';
    case 'agent-empty':
    case 'agent-down':
    case 'passphrase':
    case 'auth-rejected':
      return 'auth';
    case 'hostkey-new':
    case 'hostkey-mismatch':
      return 'hostkey';
    case 'agent-missing-deps':
      return 'agent';
  }
}

function CopyLine({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-[6px] border border-line bg-base py-1 pl-3 pr-1 font-mono text-[12px]">
      <span className="selectable min-w-0 flex-1 truncate">{text}</span>
      <button
        className="flex h-6 items-center gap-1 rounded-[4px] px-2 font-sans text-muted hover:bg-hover hover:text-fg"
        onClick={() => void invoke('clipboard.write', { text })}
      >
        <Copy size={12} aria-hidden /> {t.connect.copy}
      </button>
    </div>
  );
}

function Passphrase({ wrong }: { wrong: boolean }) {
  const [v, setV] = useState('');
  return (
    <form
      className="mt-2 flex flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (v) void invoke('conn.passphrase', { passphrase: v });
        setV('');
      }}
    >
      <div className="flex gap-2">
        <input
          type="password"
          autoFocus
          aria-label={t.connect.passphrase}
          placeholder={t.connect.passphrase}
          className="h-8 flex-1 rounded-[4px] border border-control bg-base px-2.5 outline-none focus:border-accent focus:outline focus:outline-1 focus:outline-accent"
          value={v}
          onChange={(e) => setV(e.target.value)}
        />
        <Button variant="primary" type="submit">
          {t.connect.login}
        </Button>
      </div>
      {wrong && (
        <div className="flex items-center gap-1.5 text-[12px] text-st-error" role="alert">
          <X size={12} aria-hidden />
          {t.connect.wrongPassphrase}
        </div>
      )}
    </form>
  );
}

function StepDetail({ s, platform }: { s: Extract<ConnState, { kind: 'needs-user' }>; platform: string }) {
  const [pass, setPass] = useState(s.reason === 'passphrase');
  const keyPath =
    s.detail || (platform === 'win32' ? '$env:USERPROFILE\\.ssh\\id_ed25519' : '~/.ssh/id_ed25519');
  switch (s.reason) {
    case 'config':
      return (
        <div className="space-y-2">
          <div>{s.detail ?? t.connect.configMissing}</div>
          <div className="text-[12px] text-muted">{t.connect.manualHint}</div>
          <Button onClick={() => useUi.getState().set({ settingsOpen: 'connection' })}>
            {t.connect.openSettings}
          </Button>
        </div>
      );
    case 'agent-empty':
    case 'agent-down':
    case 'passphrase':
      return (
        <div className="space-y-2">
          {s.reason === 'agent-down' ? (
            <>
              <div className="text-st-error">{t.connect.agentDown}</div>
              <div className="text-[12px] text-muted">{t.connect.agentDownHelp}</div>
              <CopyLine text={platform === 'win32' ? 'Start-Service ssh-agent' : 'eval "$(ssh-agent -s)"'} />
            </>
          ) : s.reason === 'agent-empty' ? (
            <>
              <div className="text-st-error">{t.connect.agentEmpty}</div>
              <div className="text-[12px] text-muted">{t.connect.agentEmptyHelp}</div>
              <CopyLine text={`ssh-add ${keyPath}`} />
              <div className="text-[12px] text-faint">{t.connect.agentEmptyNote}</div>
            </>
          ) : null}
          <div className="flex items-center gap-2">
            <Button onClick={() => void invoke('conn.retryNow')}>{t.connect.checkAgain}</Button>
            <span className="text-[12px] text-faint">{t.connect.or}</span>
            <Button onClick={() => setPass(true)}>{t.connect.enterPassphrase}</Button>
          </div>
          {pass && <Passphrase wrong={s.reason === 'passphrase'} />}
        </div>
      );
    case 'auth-rejected':
      return (
        <div className="space-y-2">
          <div className="text-st-error">{t.connect.rejected(s.detail ?? '')}</div>
          <Button onClick={() => void invoke('conn.retryNow')}>{t.connect.checkAgain}</Button>
        </div>
      );
    case 'hostkey-new':
      return (
        <div className="space-y-2">
          <div>{t.connect.hostNew(s.host ?? '')}</div>
          <div className="selectable rounded-[6px] bg-base px-3 py-2 font-mono text-[12px]">
            {s.fingerprint}
          </div>
          <div className="text-[12px] text-muted">{t.connect.hostNewQ}</div>
          <CopyLine text="ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub" />
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => void invoke('conn.trustHost', { accept: true })}>
              {t.connect.trust}
            </Button>
            <Button onClick={() => void invoke('conn.trustHost', { accept: false })}>
              {t.actions.cancel}
            </Button>
          </div>
        </div>
      );
    case 'hostkey-mismatch':
      return (
        <div className="space-y-2 rounded-[6px] border border-st-error p-3" role="alert">
          <div className="flex items-center gap-2 font-semibold text-st-error">
            <ShieldAlert size={16} aria-hidden /> {t.connect.hostMismatch}
          </div>
          <div className="selectable font-mono text-[12px]">
            {s.host}: {s.fingerprint}
          </div>
          <div className="text-[12px] text-muted">{t.connect.hostMismatchHelp}</div>
        </div>
      );
    case 'agent-missing-deps':
      return (
        <div className="space-y-2">
          <div className="text-st-error">{s.detail ?? t.connect.missingDeps}</div>
          <Button onClick={() => void invoke('conn.retryNow')}>{t.connect.checkAgain}</Button>
        </div>
      );
  }
}

function useCountdown(target: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!target) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [target]);
  return target ? Math.max(0, Math.ceil((target - now) / 1000)) : 0;
}

export function ConnectScreen() {
  const s = useConn((c) => c.state);
  const settings = useUi((u) => u.settings);
  const [hosts, setHosts] = useState<SshHostsInfo | null>(null);
  const [log, setLog] = useState<string[] | null>(null);
  const platform = window.cs?.platform ?? 'win32';
  const left = useCountdown(s.kind === 'offline' ? s.retryAt : null);
  useEffect(() => {
    void invoke('conn.hosts').then(setHosts);
  }, []);
  const failed = failedStep(s);
  const current: ConnStep | null = s.kind === 'connecting' ? s.step : failed;
  const order = STEPS.map((x) => x.id);
  const local = settings?.connection.mode === 'local';
  const r = hosts?.resolved;
  return (
    <div
      className="flex h-full w-full items-start justify-center overflow-auto bg-base px-6 pb-10 pt-[9vh]"
      data-testid="connect-screen"
    >
      <div className="w-[600px] max-w-full">
        <div className="mb-2 flex items-center gap-3">
          <span className="diamond text-[22px]" aria-hidden />
          <h1 className="text-[22px] font-semibold tracking-[-0.01em]">{t.connect.title}</h1>
        </div>
        <p className="mb-6 text-[13px] text-muted">{t.connect.subtitle}</p>
        <div className="mb-6 space-y-1 rounded-[10px] border border-line-strong bg-surface px-4 py-3 text-[13px]">
          <div className="flex gap-3">
            <span className="w-14 shrink-0 text-muted">{t.connect.host}</span>
            <span className="mono selectable min-w-0 break-all">
              {local
                ? t.connect.local
                : settings?.connection.manual
                  ? `${settings.connection.manual.user}@${settings.connection.manual.hostname}:${settings.connection.manual.port}`
                  : r
                    ? `${settings?.connection.host}  ${r.user}@${r.hostname}:${r.port}  ${t.connect.fromConfig}`
                    : settings?.connection.host}
            </span>
          </div>
          {!local && r?.identityFile && (
            <div className="flex gap-3">
              <span className="w-14 shrink-0 text-muted">{t.connect.key}</span>
              <span className="mono selectable min-w-0 break-all">{r.identityFile}</span>
            </div>
          )}
        </div>
        <ol className="relative space-y-3 pl-1">
          <span className="absolute bottom-3 left-[11px] top-3 w-px bg-line-strong" aria-hidden />
          {STEPS.map((step) => {
            const idx = order.indexOf(step.id);
            const curIdx = current ? order.indexOf(current) : -1;
            const state: 'wait' | 'run' | 'ok' | 'fail' =
              failed === step.id
                ? 'fail'
                : s.kind === 'online' || (curIdx > idx && current)
                  ? 'ok'
                  : current === step.id && s.kind === 'connecting'
                    ? 'run'
                    : 'wait';
            const ring =
              state === 'ok'
                ? 'border-st-idle bg-st-idle text-[var(--bg-base)]'
                : state === 'fail'
                  ? 'border-st-error bg-st-error text-[var(--bg-base)]'
                  : state === 'run'
                    ? 'border-st-busy bg-base text-st-busy'
                    : 'border-line-strong bg-base text-faint';
            return (
              <li key={step.id} className="relative">
                <div className="flex items-center gap-3 text-[13px]">
                  <span
                    className={`z-[1] flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border ${ring} ${state === 'ok' ? 'anim-pop' : ''}`}
                  >
                    {state === 'ok' && <Check size={13} strokeWidth={3} aria-hidden />}
                    {state === 'fail' && <X size={13} strokeWidth={3} aria-hidden />}
                    {state === 'run' && (
                      <LoaderCircle size={13} strokeWidth={2.5} className="anim-spin" aria-hidden />
                    )}
                    {state === 'wait' && <Circle size={7} fill="currentColor" aria-hidden />}
                  </span>
                  <span className={state === 'wait' ? 'text-muted' : 'font-medium'}>
                    {step.id === 'config' && state === 'ok' ? t.connect.configRead : step.label}
                  </span>
                  {state === 'run' && s.kind === 'connecting' && s.detail && (
                    <span className="text-[12px] text-muted">{s.detail}</span>
                  )}
                </div>
                {state === 'fail' && s.kind === 'needs-user' && (
                  <div className="anim-rise ml-[34px] mt-2 rounded-[10px] border border-line-strong bg-surface p-4 text-[13px] leading-relaxed">
                    <StepDetail s={s} platform={platform} />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {s.kind === 'offline' && (
          <div
            className="mt-6 rounded-[10px] border border-line-strong bg-surface p-4 text-[13px]"
            role="alert"
          >
            <div className="flex items-start gap-2 font-medium">
              <WifiOff size={15} className="mt-0.5 shrink-0 text-st-error" aria-hidden />
              {s.error.startsWith('VM недоступна') ? s.error : t.connect.unreachable(s.error)}
            </div>
            <div className="mt-2 flex items-center gap-3">
              <span className="tnum text-muted">{t.connect.retryIn(left)}</span>
              <Button small onClick={() => void invoke('conn.retryNow')}>
                {t.connect.retryNow}
              </Button>
            </div>
          </div>
        )}
        <div className="mt-8">
          <button
            className="inline-flex h-7 items-center gap-1 rounded-[6px] px-2 text-[12px] text-muted hover:bg-hover hover:text-fg"
            aria-expanded={!!log}
            onClick={() => (log ? setLog(null) : void invoke('conn.log').then(setLog))}
          >
            {log ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}{' '}
            {t.connect.details}
          </button>
          {log && (
            <div className="mt-2 text-left">
              <pre className="selectable max-h-56 overflow-auto rounded-[6px] border border-line bg-surface p-3 font-mono text-[11px]">
                {log.join('\n')}
              </pre>
              <Button
                small
                className="mt-1"
                onClick={() => void invoke('clipboard.write', { text: log.join('\n') })}
              >
                <Copy size={12} aria-hidden /> {t.connect.copyLog}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
