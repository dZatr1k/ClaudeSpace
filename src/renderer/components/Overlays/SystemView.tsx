import { Cpu, Gauge, RefreshCw, Stethoscope } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Doctor, SystemStats, Usage } from '@shared/model';
import { agent } from '../../bridge';
import { t } from '../../i18n/ru';
import { formatAgo, formatLeft, formatTokens, formatUptime } from '../../lib/format';
import { useConn } from '../../stores/conn';
import { useData } from '../../stores/data';
import type { SystemSection } from '../../stores/ui';
import { useUi } from '../../stores/ui';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';

function hhmm(ms: number) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function UsagePane() {
  const cached = useData((d) => d.usage);
  const online = useConn((c) => c.state.kind === 'online');
  const [u, setU] = useState<Usage | null>(cached);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (maxAge: number) => {
    setBusy(true);
    try {
      const r = await agent('usage', { maxAge });
      setU(r);
      useData.getState().setUsage(r);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (online) void load(60);
  }, [online, load]);
  if (!u) return <div className="text-muted">{err ? t.info.failed(err) : t.info.loading}</div>;
  if (!u.ok)
    return (
      <div className="space-y-2">
        <div>
          {u.error === 'ccusage не установлен' ? t.system.noCcusage : (u.error ?? 'ccusage не ответил')}
        </div>
        <code className="selectable rounded bg-hover px-2 py-1 font-mono text-[12px]">
          {t.system.ccusageInstall}
        </code>
      </div>
    );
  const max = Math.max(1, ...u.days.map((d) => d.tokens));
  return (
    <div className="space-y-4 text-[13px]">
      <div>
        <div className="mb-1 font-semibold">{t.system.usageWindow}</div>
        {u.block ? (
          <div className="space-y-0.5 text-muted tnum">
            <div>
              {t.system.tokens} <span className="text-fg">{formatTokens(u.block.tokens)}</span> ·{' '}
              {t.system.left} {formatLeft(u.block.leftMin)} · {t.system.apiCost(u.block.costUsd.toFixed(2))}
            </div>
            <div>
              {t.system.models}: {u.block.models.join(', ') || '—'}
            </div>
          </div>
        ) : (
          <div className="text-muted">{t.system.noBlock}</div>
        )}
      </div>
      <div>
        <div className="mb-1 font-semibold">{t.system.week}</div>
        {u.days.map((d) => (
          <div key={d.day} className="flex items-center gap-2 tnum text-[12px]">
            <span className="w-12 text-muted">{d.day.slice(5)}</span>
            <div className="h-3 flex-1">
              <div
                className="h-3 rounded-sm bg-accent/70"
                style={{ width: `${Math.max(1, (100 * d.tokens) / max)}%` }}
              />
            </div>
            <span className="w-14 text-right">{formatTokens(d.tokens)}</span>
          </div>
        ))}
        <div className="mt-1 text-[12px] text-muted tnum">
          {t.system.total} {formatTokens(u.weekTokens)}
        </div>
      </div>
      <div className="text-[12px] text-faint">{t.system.usageNote}</div>
      <div className="flex items-center gap-2 text-[12px] text-muted">
        {t.system.updated(hhmm(u.at))}
        <Button small onClick={() => void load(0)} disabled={busy || !online}>
          <RefreshCw size={12} className={busy ? 'anim-spin' : ''} />
          {t.system.refresh}
        </Button>
      </div>
    </div>
  );
}

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
      <div className="text-muted">{err ? t.info.failed(err) : busy ? t.info.loading : t.system.offline}</div>
    );
  return (
    <div className="space-y-4 text-[13px]">
      <div>
        Claude Code <b>{d.claudeVersion ?? '?'}</b> · {t.system.knownGood} {d.knownGood ?? '—'} ·{' '}
        <span className={LV[d.level]}>{t.system.doctorLevel[d.level]}</span>
        {d.problems.length > 0 && <div className="text-[12px] text-st-waiting">{d.problems.join('; ')}</div>}
      </div>
      <table className="w-full text-[12px]">
        <tbody>
          {d.fields.map((f) => (
            <tr key={f.key} className="border-b border-line">
              <td className={`w-12 py-0.5 font-mono ${LV[f.level]}`}>{f.level.toUpperCase()}</td>
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
        <div className="mb-0.5 font-semibold">{t.system.registry}</div>
        <div className="text-[12px] text-muted">
          {t.system.live(d.registry.live)}
          {d.registry.missing.length ? `, нет полей: ${d.registry.missing.join(', ')}` : ''}
        </div>
      </div>
      <div>
        <div className="mb-0.5 font-semibold">{t.system.tools}</div>
        {d.tools.map((x) => (
          <div key={x.name} className="flex gap-2 text-[12px]">
            <span className={`w-10 font-mono ${x.ok ? LV.ok : x.name === 'fzf' ? 'text-faint' : LV.warn}`}>
              {x.ok ? 'OK' : 'нет'}
            </span>
            <span className="w-32">{x.name}</span>
            <span className="min-w-0 flex-1 truncate text-muted">{x.detail}</span>
          </div>
        ))}
      </div>
      <Button small onClick={() => void load()} disabled={busy || !online}>
        <RefreshCw size={12} className={busy ? 'anim-spin' : ''} />
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
  if (!s) return <div className="text-muted">{t.system.offline}</div>;
  const stale = mosh.filter((m) => !m.current);
  return (
    <div className="space-y-4 text-[13px]">
      {!online && <div className="text-st-error">{t.system.offline}</div>}
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
          <div className="mb-0.5 font-semibold">{t.system.topProcs}</div>
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
        <div className="mb-0.5 font-semibold">{t.system.mosh}</div>
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
                    useUi.getState().toast(`Закрыто: ${r.killed}`, 'success');
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
    { id: 'usage', label: t.actions.usage, icon: <Gauge size={14} /> },
    {
      id: 'doctor',
      label: t.actions.doctor + (doctor && doctor.level !== 'ok' ? ' ⚠' : ''),
      icon: <Stethoscope size={14} />,
    },
    { id: 'resources', label: t.actions.resources, icon: <Cpu size={14} /> },
  ];
  return (
    <Modal open onClose={() => useUi.getState().set({ system: null })} title={t.system.title} width={760}>
      <div className="flex min-h-[420px] gap-4">
        <nav className="flex w-36 shrink-0 flex-col gap-0.5 border-r border-line pr-3">
          {items.map((x) => (
            <button
              key={x.id}
              className={`flex h-8 items-center gap-2 rounded px-2 text-left text-[13px] ${section === x.id ? 'bg-selected' : 'hover:bg-hover'}`}
              onClick={() => useUi.getState().set({ system: x.id })}
            >
              {x.icon}
              {x.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {section === 'usage' && <UsagePane />}
          {section === 'doctor' && <DoctorPane />}
          {section === 'resources' && <ResourcesPane />}
        </div>
      </div>
    </Modal>
  );
}
