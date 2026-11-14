// Connection / first run screen (DESIGN §3.2): steps with state, explanations and actions.
import { Check, ChevronDown, ChevronRight, Circle, Copy, LoaderCircle, ShieldAlert, X } from 'lucide-react';
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
    <div className="flex items-center gap-2 rounded bg-base px-2 py-1 font-mono text-[12px]">
      <span className="selectable min-w-0 flex-1 truncate">{text}</span>
      <button
        className="flex items-center gap-1 text-muted hover:text-fg"
        onClick={() => void invoke('clipboard.write', { text })}
      >
        <Copy size={12} /> {t.connect.copy}
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
          className="h-8 flex-1 rounded-[4px] border border-line-strong bg-base px-2 outline-none focus:border-accent"
          value={v}
          onChange={(e) => setV(e.target.value)}
        />
        <Button variant="primary" type="submit">
          {t.connect.login}
        </Button>
      </div>
      {wrong && <div className="text-[12px] text-st-error">{t.connect.wrongPassphrase}</div>}
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
            <span className="text-[12px] text-faint">или</span>
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
          <div className="selectable font-mono text-[12px]">{s.fingerprint}</div>
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
        <div className="space-y-2 rounded border border-st-error p-3">
          <div className="flex items-center gap-2 font-semibold text-st-error">
            <ShieldAlert size={16} /> {t.connect.hostMismatch}
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
      className="flex h-full w-full items-start justify-center overflow-auto bg-base pt-[8vh]"
      data-testid="connect-screen"
    >
      <div className="w-[640px] max-w-[94%] rounded-[8px] border border-line bg-surface p-6">
        <div className="mb-5 flex items-center justify-center gap-2 text-[20px] font-semibold">
          <span className="text-accent">◆</span> {t.connect.title}
        </div>
        <div className="mb-4 space-y-1 text-[13px]">
          <div className="flex gap-3">
            <span className="w-16 text-muted">{t.connect.host}</span>
            <span>
              {local
                ? 'локально (эта машина)'
                : settings?.connection.manual
                  ? `${settings.connection.manual.user}@${settings.connection.manual.hostname}:${settings.connection.manual.port}`
                  : r
                    ? `${settings?.connection.host}  ${r.user}@${r.hostname}:${r.port}  (из ~/.ssh/config)`
                    : settings?.connection.host}
            </span>
          </div>
          {!local && r?.identityFile && (
            <div className="flex gap-3">
              <span className="w-16 text-muted">{t.connect.key}</span>
              <span className="selectable font-mono text-[12px]">{r.identityFile}</span>
            </div>
          )}
        </div>
        <div className="space-y-2">
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
            return (
              <div key={step.id}>
                <div className="flex items-center gap-2 text-[13px]">
                  {state === 'ok' && <Check size={15} className="text-st-idle" />}
                  {state === 'fail' && <X size={15} className="text-st-error" />}
                  {state === 'run' && <LoaderCircle size={15} className="anim-spin text-st-busy" />}
                  {state === 'wait' && <Circle size={15} className="text-faint" />}
                  <span className={state === 'wait' ? 'text-muted' : ''}>
                    {step.id === 'config' && state === 'ok' ? t.connect.configRead : step.label}
                  </span>
                  {state === 'run' && s.kind === 'connecting' && s.detail && (
                    <span className="text-[12px] text-muted">{s.detail}</span>
                  )}
                </div>
                {state === 'fail' && s.kind === 'needs-user' && (
                  <div className="ml-6 mt-1.5 rounded-[6px] border border-line bg-elevated p-3 text-[13px]">
                    <StepDetail s={s} platform={platform} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {s.kind === 'offline' && (
          <div className="mt-4 rounded-[6px] border border-line bg-elevated p-3 text-[13px]">
            <div className="text-st-error">
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
        <div className="mt-6 text-center">
          <button
            className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-fg"
            onClick={() => (log ? setLog(null) : void invoke('conn.log').then(setLog))}
          >
            {t.connect.details} {log ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          {log && (
            <div className="mt-2 text-left">
              <pre className="selectable max-h-56 overflow-auto rounded bg-base p-2 font-mono text-[11px]">
                {log.join('\n')}
              </pre>
              <Button
                small
                className="mt-1"
                onClick={() => void invoke('clipboard.write', { text: log.join('\n') })}
              >
                <Copy size={12} /> {t.connect.copy}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
