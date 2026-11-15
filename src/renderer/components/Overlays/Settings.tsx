import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { SshHostsInfo } from '@shared/ipc';
import { ASKPASS_ENV_LINE } from '@shared/askpass';
import type { Settings as S, SettingsPatch } from '@shared/settings';
import { invoke } from '../../bridge';
import { t } from '../../i18n/ru';
import { playNotifySound } from '../../lib/chime';
import type { SettingsSection } from '../../stores/ui';
import { useUi } from '../../stores/ui';
import { usePcLink } from '../../stores/pclink';
import { pcLinkText } from '../StatusBar/PcLinkIndicator';
import { useUpdate } from '../../stores/update';
import { updateStatusText } from '../../lib/update';
import { formatClock } from '../../lib/format';
import { restartAndUpdate } from './UpdateNotice';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';

async function patch(p: SettingsPatch) {
  const next = await invoke('settings.set', p);
  useUi.getState().set({ settings: next });
}

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex items-start gap-4 border-b border-line py-2.5 text-[13px] last:border-b-0">
      <span className="w-52 shrink-0 pt-1 leading-snug">{label}</span>
      <span className="min-w-0 flex-1">
        {children}
        {hint && <div className="mt-1 text-[12px] leading-snug text-faint">{hint}</div>}
      </span>
    </label>
  );
}

const inputCls =
  'h-7 w-full rounded-[4px] border border-control bg-base px-2 text-[13px] outline-none focus:border-accent focus:outline focus:outline-1 focus:outline-accent';

function Text({
  value,
  onCommit,
  placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className={inputCls}
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

function Num({
  value,
  min,
  max,
  step = 1,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (v: number) => void;
}) {
  return (
    <input
      type="number"
      className={`${inputCls.replace('w-full', '')} w-24`}
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (!Number.isNaN(n) && n >= min && n <= max) onCommit(n);
      }}
    />
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <input
      type="checkbox"
      className="mt-1 h-4 w-4 accent-[var(--accent)]"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { v: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-[6px] border border-line bg-base p-0.5" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          className={`h-6 rounded-[4px] px-3 text-[12px] transition-colors duration-100 ${value === o.v ? 'bg-selected font-semibold text-fg' : 'text-muted hover:bg-hover hover:text-fg'}`}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ThemeCard({
  id,
  label,
  active,
}: {
  id: 'system' | 'dark' | 'light';
  label: string;
  active: boolean;
}) {
  const half = (bg: string, fg: string, acc: string) => (
    <div className="flex h-full flex-1 flex-col gap-1 p-1.5" style={{ background: bg }}>
      <div className="h-1.5 w-1.5 rotate-45" style={{ background: acc }} />
      <div className="h-1 w-12 rounded" style={{ background: fg, opacity: 0.7 }} />
      <div className="h-1 w-10 rounded" style={{ background: fg, opacity: 0.35 }} />
    </div>
  );
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={() => void patch({ appearance: { theme: id } })}
      className={`flex w-28 flex-col overflow-hidden rounded-[6px] border-2 text-[12px] transition-colors duration-100 ${active ? 'border-accent' : 'border-line-strong hover:border-control'}`}
    >
      {/* previews show both themes at once, so the colours are literal here (DESIGN §5.1) */}
      <div className="flex h-14">
        {id !== 'light' && half('#121110', '#EDE9E4', '#D97757')}
        {id !== 'dark' && half('#FBFAF8', '#1D1B19', '#B4532F')}
      </div>
      <div className={`bg-elevated py-1 ${active ? 'font-semibold' : ''}`}>{label}</div>
    </button>
  );
}

function ConnectionSection({ s }: { s: S }) {
  const [hosts, setHosts] = useState<SshHostsInfo | null>(null);
  useEffect(() => {
    void invoke('conn.hosts').then(setHosts);
  }, []);
  const manual = s.connection.manual;
  return (
    <>
      <Row label={t.settings.mode}>
        <Choice
          value={s.connection.mode}
          options={[
            { v: 'ssh', label: t.settings.modeSsh },
            { v: 'local', label: t.settings.modeLocal },
          ]}
          onChange={(v) => void patch({ connection: { mode: v } })}
        />
      </Row>
      {s.connection.mode === 'ssh' && (
        <>
          <Row
            label={t.settings.host}
            hint={
              hosts
                ? hosts.found
                  ? t.settings.hostFile(hosts.configPath)
                  : t.settings.hostNoFile(hosts.configPath)
                : undefined
            }
          >
            <div className="flex gap-2">
              <select
                className={inputCls}
                value={manual ? '__manual' : s.connection.host}
                onChange={(e) =>
                  e.target.value === '__manual'
                    ? void patch({
                        connection: { manual: { hostname: '', port: 22, user: '', keyPath: '' } as never },
                      })
                    : void patch({ connection: { host: e.target.value, manual: null } })
                }
              >
                {(hosts?.hosts.length ? hosts.hosts : [s.connection.host]).map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
                <option value="__manual">{t.settings.manual}</option>
              </select>
            </div>
            {hosts?.resolved && !manual && (
              <div className="mono mt-1 text-[12px] text-muted">
                {hosts.resolved.user}@{hosts.resolved.hostname}:{hosts.resolved.port} ·{' '}
                {hosts.resolved.identityFile ?? t.settings.defaultKey}
              </div>
            )}
          </Row>
          {manual && (
            <>
              <Row label={t.settings.manualHost}>
                <Text
                  value={manual.hostname}
                  onCommit={(v) => void patch({ connection: { manual: { ...manual, hostname: v } } })}
                />
              </Row>
              <Row label={t.settings.manualPort}>
                <Num
                  value={manual.port}
                  min={1}
                  max={65535}
                  onCommit={(v) => void patch({ connection: { manual: { ...manual, port: v } } })}
                />
              </Row>
              <Row label={t.settings.manualUser}>
                <Text
                  value={manual.user}
                  onCommit={(v) => void patch({ connection: { manual: { ...manual, user: v } } })}
                />
              </Row>
              <Row label={t.settings.manualKey}>
                <Text
                  value={manual.keyPath}
                  placeholder="~/.ssh/id_ed25519"
                  onCommit={(v) => void patch({ connection: { manual: { ...manual, keyPath: v } } })}
                />
              </Row>
            </>
          )}
          <Row label={t.settings.keepalive}>
            <Num
              value={s.connection.keepaliveSec}
              min={5}
              max={120}
              onCommit={(v) => void patch({ connection: { keepaliveSec: v } })}
            />
          </Row>
        </>
      )}
    </>
  );
}

function NotificationsSection({ s }: { s: S }) {
  const n = s.notifications;
  const [vol, setVol] = useState(n.volume);
  useEffect(() => setVol(n.volume), [n.volume]);
  return (
    <>
      <div className="mb-1 text-[12px] leading-snug text-muted">{t.settings.notifyHint}</div>
      <Row label={t.settings.notifySystem}>
        <Toggle checked={n.system} onChange={(v) => void patch({ notifications: { system: v } })} />
      </Row>
      <Row label={t.settings.notifyToast}>
        <Toggle checked={n.toast} onChange={(v) => void patch({ notifications: { toast: v } })} />
      </Row>
      <Row label={t.settings.notifySound}>
        <Toggle checked={n.sound} onChange={(v) => void patch({ notifications: { sound: v } })} />
      </Row>
      <Row label={t.settings.notifyVolume}>
        <span className="flex items-center gap-2">
          <input
            type="range"
            aria-label={t.settings.notifyVolume}
            className="w-40 accent-[var(--accent)]"
            min={0}
            max={100}
            step={5}
            value={Math.round(vol * 100)}
            disabled={!n.sound}
            onChange={(e) => setVol(Number(e.target.value) / 100)}
            onPointerUp={() => vol !== n.volume && void patch({ notifications: { volume: vol } })}
            onKeyUp={() => vol !== n.volume && void patch({ notifications: { volume: vol } })}
          />
          <span className="tnum w-10 text-[12px] text-muted">{Math.round(vol * 100)}%</span>
          <Button
            small
            onClick={() => {
              // test both parts: the toast (if enabled) and the sound (file or chime)
              if (n.toast) useUi.getState().toast(t.notify.waiting(t.settings.notifyTestName), 'info');
              if (n.system)
                void invoke('notify.show', {
                  title: t.notify.waiting(t.settings.notifyTestName),
                  body: t.notify.systemBody,
                  session: '',
                }).then((r) => !r.ok && useUi.getState().toast(t.settings.notifySystemFailed, 'error'));
              if (n.sound)
                void playNotifySound(vol, 'waiting', n.soundFile).then((how) =>
                  useUi
                    .getState()
                    .toast(how === 'file' ? t.settings.notifySoundFile : t.settings.notifySoundChime),
                );
            }}
          >
            {t.settings.notifyTest}
          </Button>
        </span>
      </Row>
      <Row label={t.settings.notifyFile} hint={t.settings.notifyFileHint}>
        <input
          className={`${inputCls.replace('w-full', '')} w-80`}
          placeholder="%USERPROFILE%\\.claude\\sounds\\sound.wav"
          defaultValue={n.soundFile}
          disabled={!n.sound}
          onBlur={(e) =>
            e.target.value !== n.soundFile && void patch({ notifications: { soundFile: e.target.value } })
          }
        />
      </Row>
      <Row label={t.ports.notifyNew}>
        <Toggle checked={s.ports.notifyNew} onChange={(v) => void patch({ ports: { notifyNew: v } })} />
      </Row>
      <Row label={t.settings.notifyOnlyBackground}>
        <Toggle
          checked={n.onlyBackground}
          onChange={(v) => void patch({ notifications: { onlyBackground: v } })}
        />
      </Row>
    </>
  );
}

const SRC_RE = /^[A-Za-z]:([\\/].*)?$/;
const DST_RE = /^(~\/|\/).+/;

function PcLinkSection({ s }: { s: S }) {
  const p = s.pcLink;
  const st = usePcLink((x) => x.state);
  const [src, setSrc] = useState('');
  const [dst, setDst] = useState('');
  const valid = SRC_RE.test(src.trim()) && DST_RE.test(dst.trim());
  return (
    <>
      <div className="mb-1 text-[12px] leading-snug text-muted">{t.pclink.hint}</div>
      <Row label={t.pclink.state}>
        <span className="flex items-center gap-2 pt-1">
          <span>{pcLinkText(st)}</span>
          {st.tunnel !== 'local' && st.tunnel !== 'waiting' && st.tunnel !== 'off' && (
            <Button small onClick={() => void invoke('pclink.reconnect')}>
              {t.pclink.reconnect}
            </Button>
          )}
        </span>
        {st.detail && <div className="mt-0.5 text-[12px] text-faint">{st.detail}</div>}
        {st.sshd === 'down' && (
          <div className="mt-0.5 text-[12px] text-st-waiting">{t.pclink.sshdDownHint}</div>
        )}
      </Row>
      <Row label={t.pclink.tunnel} hint={t.pclink.tunnelHint}>
        <Toggle
          checked={p.tunnel}
          disabled={s.connection.mode !== 'ssh'}
          onChange={(v) => void patch({ pcLink: { tunnel: v } })}
        />
      </Row>
      <Row label={t.pclink.autoMount}>
        <Toggle checked={p.autoMount} onChange={(v) => void patch({ pcLink: { autoMount: v } })} />
      </Row>
      <Row label={t.pclink.mounts} hint={t.pclink.mountsHint}>
        <div className="flex flex-col gap-1">
          {p.mounts.map((m, i) => (
            <div key={`${m.dst}-${i}`} className="flex items-center gap-2 font-mono text-[12px]">
              <span className="min-w-0 flex-1 truncate">
                {m.src} → {m.dst}
              </span>
              <Button
                small
                onClick={() => void patch({ pcLink: { mounts: p.mounts.filter((_, j) => j !== i) } })}
              >
                {t.pclink.remove}
              </Button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <input
              className={`${inputCls.replace('w-full', '')} w-40`}
              placeholder={t.pclink.srcPh}
              value={src}
              onChange={(e) => setSrc(e.target.value)}
            />
            <span>→</span>
            <input
              className={`${inputCls.replace('w-full', '')} w-40`}
              placeholder={t.pclink.dstPh}
              value={dst}
              onChange={(e) => setDst(e.target.value)}
            />
            <Button
              small
              disabled={!valid || p.mounts.length >= 8}
              title={valid ? undefined : t.pclink.badMount}
              onClick={() => {
                void patch({ pcLink: { mounts: [...p.mounts, { src: src.trim(), dst: dst.trim() }] } });
                setSrc('');
                setDst('');
              }}
            >
              {t.pclink.add}
            </Button>
          </div>
        </div>
      </Row>
    </>
  );
}

function StartupTray({ s }: { s: S }) {
  const info = useUi((u) => u.appInfo);
  const autostartOk = info?.platform === 'win32' && !info.dev;
  const autostartHint =
    info?.platform !== 'win32'
      ? t.settings.autostartPlatform
      : info.dev
        ? t.settings.autostartDev
        : t.settings.autostartHint;
  return (
    <>
      <Row label={t.settings.closeToTray} hint={t.settings.closeToTrayHint}>
        <Toggle checked={s.tray.closeToTray} onChange={(v) => void patch({ tray: { closeToTray: v } })} />
      </Row>
      <Row label={t.settings.autostart} hint={autostartHint}>
        <Toggle
          checked={s.startup.autostart}
          disabled={!autostartOk}
          onChange={(v) => void patch({ startup: { autostart: v } })}
        />
      </Row>
      <Row label={t.settings.startHidden}>
        <Toggle
          checked={s.startup.startHidden}
          disabled={!autostartOk || !s.startup.autostart}
          onChange={(v) => void patch({ startup: { startHidden: v } })}
        />
      </Row>
    </>
  );
}

function SudoSection({ s }: { s: S }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Row label={t.askpass.enabled} hint={t.askpass.enabledHint}>
        <Toggle checked={s.askpass.enabled} onChange={(v) => void patch({ askpass: { enabled: v } })} />
      </Row>
      <Row label={t.askpass.envLine} hint={t.askpass.envHint}>
        <span className="flex items-center gap-2">
          <code className="selectable min-w-0 flex-1 truncate rounded-[4px] border border-line bg-base px-2 py-1 font-mono text-[12px]">
            {ASKPASS_ENV_LINE}
          </code>
          <Button
            small
            onClick={() => {
              void invoke('clipboard.write', { text: ASKPASS_ENV_LINE });
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? t.askpass.copied : t.askpass.copy}
          </Button>
        </span>
      </Row>
    </>
  );
}

function UpdatesRows({ s }: { s: S }) {
  const st = useUpdate((u) => u.state);
  const off = st.status === 'disabled';
  const busy = st.status === 'checking' || st.status === 'downloading' || st.status === 'available';
  return (
    <>
      <Row label={t.update.status}>
        <div className="flex flex-wrap items-center gap-2 pt-0.5" data-update-status={st.status}>
          <span className={st.status === 'error' ? 'text-st-error' : ''}>{updateStatusText(st)}</span>
          {!off && st.status !== 'ready' && (
            <Button small disabled={busy} onClick={() => void invoke('update.check')}>
              {t.update.check}
            </Button>
          )}
          {st.status === 'ready' && (
            <Button small variant="primary" onClick={restartAndUpdate}>
              {t.update.restart}
            </Button>
          )}
        </div>
        {st.lastCheck && (
          <div className="mt-0.5 text-[12px] text-faint">{t.update.lastCheck(formatClock(st.lastCheck))}</div>
        )}
      </Row>
      <Row label={t.update.auto} hint={t.update.autoHint}>
        <Toggle
          checked={s.updates.auto}
          disabled={off}
          onChange={(v) => void patch({ updates: { auto: v } })}
        />
      </Row>
    </>
  );
}

function AboutSection({ s }: { s: S }) {
  const info = useUi((u) => u.appInfo);
  const [log, setLog] = useState<string[] | null>(null);
  return (
    <>
      <Row label={t.settings.version}>
        <span className="mono">{info?.version}</span>
      </Row>
      <UpdatesRows s={s} />
      <Row label={t.settings.agent}>
        <span className="mono">{info?.agentVersion}</span>{' '}
        <span className="font-mono text-[11px] text-faint">{info?.agentHash.slice(0, 19)}…</span>
      </Row>
      <Row label={t.settings.protocol}>
        <span className="mono">{info?.protocol}</span>
      </Row>
      <Row label={t.settings.userData}>
        <span className="selectable font-mono text-[12px]">{info?.userData}</span>
      </Row>
      <Row label={t.settings.logs}>
        <Button small onClick={() => void invoke('conn.log').then(setLog)}>
          {t.actions.show}
        </Button>
      </Row>
      {log && (
        <pre className="selectable max-h-60 overflow-auto rounded-[6px] border border-line bg-base p-3 font-mono text-[11px]">
          {log.join('\n')}
        </pre>
      )}
    </>
  );
}

export function SettingsOverlay() {
  const section = useUi((u) => u.settingsOpen);
  const s = useUi((u) => u.settings);
  if (!section || !s) return null;
  const nav: { id: SettingsSection; label: string }[] = [
    { id: 'connection', label: t.settings.connection },
    { id: 'pclink', label: t.settings.pclink },
    { id: 'sudo', label: t.settings.sudo },
    { id: 'appearance', label: t.settings.appearance },
    { id: 'terminal', label: t.settings.terminal },
    { id: 'notifications', label: t.settings.notifications },
    { id: 'startup', label: t.settings.startup },
    { id: 'integrations', label: t.settings.integrations },
    { id: 'about', label: t.settings.about },
  ];
  return (
    <Modal
      open
      onClose={() => useUi.getState().set({ settingsOpen: null })}
      title={t.settings.title}
      width={820}
    >
      <div className="flex min-h-[440px] gap-5">
        <nav className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-line pr-3">
          {nav.map((x) => (
            <button
              key={x.id}
              aria-current={section === x.id ? 'page' : undefined}
              className={`relative h-8 rounded-[6px] px-2.5 text-left text-[13px] transition-colors duration-100 ${section === x.id ? 'bg-selected font-semibold' : 'text-muted hover:bg-hover hover:text-fg'}`}
              onClick={() => useUi.getState().set({ settingsOpen: x.id })}
            >
              {x.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1" data-settings={section}>
          {section === 'connection' && <ConnectionSection s={s} />}
          {section === 'pclink' && <PcLinkSection s={s} />}
          {section === 'sudo' && <SudoSection s={s} />}
          {section === 'appearance' && (
            <>
              <Row label={t.settings.theme}>
                <div className="flex gap-2" role="radiogroup" aria-label={t.settings.theme}>
                  <ThemeCard
                    id="system"
                    label={t.settings.themeSystem}
                    active={s.appearance.theme === 'system'}
                  />
                  <ThemeCard id="dark" label={t.settings.themeDark} active={s.appearance.theme === 'dark'} />
                  <ThemeCard
                    id="light"
                    label={t.settings.themeLight}
                    active={s.appearance.theme === 'light'}
                  />
                </div>
              </Row>
              <Row label={t.settings.uiFont}>
                <Num
                  value={s.appearance.uiFontSize}
                  min={12}
                  max={15}
                  onCommit={(v) => void patch({ appearance: { uiFontSize: v } })}
                />
              </Row>
              <Row label={t.settings.density}>
                <Choice
                  value={s.appearance.density}
                  options={[
                    { v: 'compact', label: t.settings.compact },
                    { v: 'normal', label: t.settings.normal },
                  ]}
                  onChange={(v) => void patch({ appearance: { density: v } })}
                />
              </Row>
            </>
          )}
          {section === 'terminal' && (
            <>
              <Row label={t.settings.font}>
                <select
                  className={inputCls}
                  value={s.terminal.fontFamily}
                  onChange={(e) => void patch({ terminal: { fontFamily: e.target.value } })}
                >
                  {[
                    'JetBrains Mono',
                    'Cascadia Mono',
                    'Consolas',
                    ...(['JetBrains Mono', 'Cascadia Mono', 'Consolas'].includes(s.terminal.fontFamily)
                      ? []
                      : [s.terminal.fontFamily]),
                  ].map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
              </Row>
              <Row label={t.settings.fontSize}>
                <Num
                  value={s.terminal.fontSize}
                  min={11}
                  max={20}
                  onCommit={(v) => void patch({ terminal: { fontSize: v } })}
                />
              </Row>
              <Row label={t.settings.lineHeight}>
                <Num
                  value={s.terminal.lineHeight}
                  min={1}
                  max={1.4}
                  step={0.05}
                  onCommit={(v) => void patch({ terminal: { lineHeight: v } })}
                />
              </Row>
              <Row label={t.settings.cursor}>
                <div className="flex items-center gap-3">
                  <Choice
                    value={s.terminal.cursorStyle}
                    options={[
                      { v: 'block', label: t.settings.cursorBlock },
                      { v: 'bar', label: t.settings.cursorBar },
                    ]}
                    onChange={(v) => void patch({ terminal: { cursorStyle: v } })}
                  />
                  <span className="flex items-center gap-1 text-[12px] text-muted">
                    <Toggle
                      checked={s.terminal.cursorBlink}
                      onChange={(v) => void patch({ terminal: { cursorBlink: v } })}
                    />{' '}
                    {t.settings.cursorBlink}
                  </span>
                </div>
              </Row>
              <Row label={t.settings.renderer} hint={t.settings.rendererHint}>
                <Choice
                  value={s.terminal.renderer}
                  options={[
                    { v: 'dom', label: t.settings.rendererDom },
                    { v: 'webgl', label: t.settings.rendererWebgl },
                  ]}
                  onChange={(v) => void patch({ terminal: { renderer: v } })}
                />
              </Row>
              <Row label={t.settings.hideTmuxStatus} hint={t.settings.hideTmuxStatusHint}>
                <Toggle
                  checked={s.terminal.hideTmuxStatus}
                  onChange={(v) => void patch({ terminal: { hideTmuxStatus: v } })}
                />
              </Row>
              <Row label={t.settings.scrollback}>
                <Num
                  value={s.terminal.scrollback}
                  min={500}
                  max={100000}
                  step={500}
                  onCommit={(v) => void patch({ terminal: { scrollback: v } })}
                />
              </Row>
              <Row label={t.settings.ctrlC}>
                <Toggle
                  checked={s.terminal.ctrlCCopies}
                  onChange={(v) => void patch({ terminal: { ctrlCCopies: v } })}
                />
              </Row>
              <Row label={t.settings.ctrlV}>
                <Toggle
                  checked={s.terminal.ctrlVPastes}
                  onChange={(v) => void patch({ terminal: { ctrlVPastes: v } })}
                />
              </Row>
              <Row label={t.settings.warnPaste}>
                <Toggle
                  checked={s.terminal.warnMultilinePaste}
                  onChange={(v) => void patch({ terminal: { warnMultilinePaste: v } })}
                />
              </Row>
              <div className="mt-3 text-[12px] leading-snug text-muted">{t.settings.themeHint}</div>
            </>
          )}
          {section === 'notifications' && <NotificationsSection s={s} />}
          {section === 'startup' && (
            <>
              <Row label={t.settings.restoreTabs}>
                <Toggle
                  checked={s.startup.restoreTabs}
                  onChange={(v) => void patch({ startup: { restoreTabs: v } })}
                />
              </Row>
              <StartupTray s={s} />
            </>
          )}
          {section === 'integrations' && (
            <>
              <Row label={t.settings.rdpScript} hint={t.settings.rdpScriptHint}>
                <Text
                  value={s.integrations.rdpScript}
                  placeholder={t.settings.rdpScriptPh}
                  onCommit={(v) => void patch({ integrations: { rdpScript: v } })}
                />
              </Row>
              <Row label={t.settings.vscodeCmd}>
                <Text
                  value={s.integrations.vscodeCommand}
                  onCommit={(v) => void patch({ integrations: { vscodeCommand: v } })}
                />
              </Row>
              <Row label={t.settings.remoteHost} hint={t.settings.remoteHostHint}>
                <Text
                  value={s.integrations.remoteHost}
                  placeholder={s.connection.host}
                  onCommit={(v) => void patch({ integrations: { remoteHost: v } })}
                />
              </Row>
            </>
          )}
          {section === 'about' && <AboutSection s={s} />}
        </div>
      </div>
    </Modal>
  );
}
