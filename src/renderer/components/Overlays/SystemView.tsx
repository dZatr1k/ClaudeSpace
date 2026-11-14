import { Cpu, Gauge, RefreshCw, Stethoscope, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Doctor, SystemStats } from '@shared/model';
import { agent } from '../../bridge';
import { t } from '../../i18n/ru';
import { formatAgo, formatUptime } from '../../lib/format';
import { useConn } from '../../stores/conn';
import { useData } from '../../stores/data';
import type { SystemSection } from '../../stores/ui';
import { useUi } from '../../stores/ui';
import { Button } from '../ui/Button';
import { UsageReportPane } from './UsageReport';
import { Modal } from '../ui/Modal';

const LV: Record<string, string> = {
  ok: 'text-st-idle',
  warn: 'text-st-waiting',
  fail: 'text-st-error',
  error: 'text-st-error',
};

function DoctorPane() {
  const online = useConn((c) => c.state.kind === 'online');
  const [d, setD] = useState<Doctor | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      setD(await agent('doctor', { full: true }));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (online) void load();
  }, [online, load]);
  if (!d)
    return (
      <div className="text-muted" role="status">
        {err ? t.info.failed(err) : busy ? t.info.loading : t.system.offline}
      </div>
    );
  return (
    <div className="space-y-4 text-[13px]">
      <div>
        Claude Code <b className="mono">{d.claudeVersion ?? '?'}</b> · {t.system.knownGood}{' '}
        <span className="mono">{d.knownGood ?? t.system.noModels}</span> ·{' '}
        <span className={`font-semibold ${LV[d.level]}`}>{t.system.doctorLevel[d.level]}</span>
        {d.problems.length > 0 && (
          <div className="mt-1 text-[12px] text-st-waiting">{d.problems.join('; ')}</div>
        )}
      </div>
      <table className="w-full text-[12px]">
        <tbody>
          {d.fields.map((f) => (
            <tr key={f.key} className="border-b border-line">
              <td className={`w-12 py-1 font-mono font-semibold ${LV[f.level]}`}>{f.level.toUpperCase()}</td>
              <td>{f.label}</td>
              <td className="text-muted tnum">
                {t.system.found(f.found, f.total)}
                {f.note ? ` (${f.note})` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        <h3 className="mb-1 text-[13px] font-semibold">{t.system.registry}</h3>
        <div className="text-[12px] text-muted">
          {t.system.live(d.registry.live)}
          {d.registry.missing.length ? t.system.missing(d.registry.missing.join(', ')) : ''}
        </div>
      </div>
      <div>
        <h3 className="mb-1 text-[13px] font-semibold">{t.system.tools}</h3>
        {d.tools.map((x) => (
          <div key={x.name} className="flex gap-2 text-[12px]">
            <span
              className={`w-10 font-mono font-semibold ${x.ok ? LV.ok : x.name === 'fzf' ? 'text-faint' : LV.warn}`}
            >
              {x.ok ? 'OK' : t.system.toolMissing}
            </span>
            <span className="mono w-32">{x.name}</span>
            <span className="mono min-w-0 flex-1 truncate text-muted">{x.detail}</span>
          </div>
        ))}
      </div>
      <Button small onClick={() => void load()} disabled={busy || !online}>
        <RefreshCw size={12} className={busy ? 'anim-spin' : ''} aria-hidden />
        {t.system.checkAgain}
      </Button>
    </div>
  );
}

function ResourcesPane() {
  const online = useConn((c) => c.state.kind === 'online');
  const last = useData((d) => d.system);
  const [s, setS] = useState<SystemStats | null>(last);
  const [mosh, setMosh] = useState<{ pid: number; ageSec: number; current: boolean }[]>([]);
  const load = useCallback(async () => {
    try {
      const [st, m] = await Promise.all([agent('system', { top: true }), agent('mosh_list')]);
      setS(st);
      setMosh(m.servers);
    } catch {
      /* keep last */
    }
  }, []);
  useEffect(() => {
    if (!online) return;
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [online, load]);
  if (!s)
    return (
      <div className="text-muted" role="status">
        {online ? t.info.loading : t.system.offline}
      </div>
    );
  const stale = mosh.filter((m) => !m.current);
  return (
    <div className="space-y-4 text-[13px]">
      {!online && (
        <div className="flex items-center gap-1.5 text-st-error" role="status">
          <WifiOff size={13} aria-hidden />
          {t.system.offline}
        </div>
      )}
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 tnum text-[12px]">
        <div>
          {t.system.load}: {s.load.map((x) => x.toFixed(2)).join(' ')}
        </div>
        <div>CPU: {s.cpuPct}%</div>
        <div>
          {t.system.ram}: {(s.memUsedMb / 1024).toFixed(1)}/{(s.memTotalMb / 1024).toFixed(1)} GB ({s.memPct}
          %)
        </div>
        <div>
          {t.system.disk}: {s.diskPct}%
        </div>
        <div>
          {t.system.uptime}: {formatUptime(s.uptimeSec)}
        </div>
        <div>
          {t.system.service}:{' '}
          <span className={s.tmuxService === 'active' ? 'text-st-idle' : 'text-st-error'}>
            {s.tmuxService}
          </span>
        </div>
      </div>
      {s.top && (
        <div>
          <h3 className="mb-1 text-[13px] font-semibold">{t.system.topProcs}</h3>
          <table className="w-full font-mono text-[11px]">
            <tbody>
              {s.top.map((p) => (
                <tr key={p.pid}>
                  <td className="w-16 text-muted">{p.pid}</td>
                  <td className="w-14 text-right">{p.cpu.toFixed(1)}%</td>
                  <td className="w-16 text-right">{p.rssMb} MB</td>
                  <td className="pl-3">{p.command}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div>
        <h3 className="mb-1 text-[13px] font-semibold">{t.system.mosh}</h3>
        {mosh.length === 0 && <div className="text-[12px] text-muted">{t.system.moshNone}</div>}
        {mosh.map((m) => (
          <div key={m.pid} className="flex gap-3 font-mono text-[11px]">
            <span className="w-16">{m.pid}</span>
            <span>{formatAgo(Date.now() - m.ageSec * 1000)}</span>
            {m.current && <span className="text-muted">← {t.system.current}</span>}
          </div>
        ))}
        {stale.length > 0 && (
          <Button
            small
            variant="danger"
            className="mt-2"
            disabled={!online}
            onClick={() =>
              useUi.getState().set({
                dialog: {
                  kind: 'confirm',
                  title: t.system.moshKillConfirm(stale.length),
                  confirm: t.system.moshKill(stale.length),
                  onConfirm: async () => {
                    const r = await agent('mosh_kill_stale');
                    useUi.getState().toast(t.toasts.closedMosh(r.killed), 'success');
                    void load();
                  },
                },
              })
            }
          >
            {t.system.moshKill(stale.length)}
          </Button>
        )}
      </div>
    </div>
  );
}

export function SystemView() {
  const section = useUi((u) => u.system);
  const doctor = useData((d) => d.doctor);
  if (!section) return null;
  const items: { id: SystemSection; label: string; icon: React.ReactNode }[] = [
    { id: 'usage', label: t.actions.usage, icon: <Gauge size={14} aria-hidden /> },
    {
      id: 'doctor',
      label: t.actions.doctor + (doctor && doctor.level !== 'ok' ? ' ⚠' : ''),
      icon: <Stethoscope size={14} aria-hidden />,
    },
    { id: 'resources', label: t.actions.resources, icon: <Cpu size={14} aria-hidden /> },
  ];
  return (
    <Modal open onClose={() => useUi.getState().set({ system: null })} title={t.system.title} width={900}>
      <div className="flex min-h-[420px] gap-5">
        <nav className="flex w-36 shrink-0 flex-col gap-0.5 border-r border-line pr-3">
          {items.map((x) => (
            <button
              key={x.id}
              aria-current={section === x.id ? 'page' : undefined}
              className={`flex h-8 items-center gap-2 rounded-[6px] px-2.5 text-left text-[13px] transition-colors duration-100 ${section === x.id ? 'bg-selected font-semibold' : 'text-muted hover:bg-hover hover:text-fg'}`}
              onClick={() => useUi.getState().set({ system: x.id })}
            >
              {x.icon}
              {x.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {section === 'usage' && <UsageReportPane />}
          {section === 'doctor' && <DoctorPane />}
          {section === 'resources' && <ResourcesPane />}
        </div>
      </div>
    </Modal>
  );
}
