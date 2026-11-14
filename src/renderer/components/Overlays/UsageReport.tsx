// «Расход»: the current 5-hour window (tokens, time to reset, pace, projection) and the period's usage by day,
// project and model. One measure (tokens), one hue; values in text tokens, the bar only carries magnitude.
// Data: agent usage_report (ccusage daily --breakdown, session, blocks; cached 2 min).
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { UsageDay, UsageReport as Report } from '@shared/protocol';
import { agent } from '../../bridge';
import { t } from '../../i18n/ru';
import { formatModel, formatTokens } from '../../lib/format';
import { useConn } from '../../stores/conn';
import { Button } from '../ui/Button';

const U = () => t.usage;
type Period = 7 | 14 | 30;
const usd = (n: number) => `$${n >= 100 ? Math.round(n) : n.toFixed(2)}`;

function hhmm(ms: number) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dayLabel(day: string, long = false): string {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y ?? 2000, (m ?? 1) - 1, d ?? 1);
  return long
    ? dt.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' })
    : String(dt.getDate());
}

function Tile({
  label,
  value,
  sub,
  children,
}: {
  label: string;
  value: string;
  sub?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-[8px] border border-line bg-base px-3 py-2.5">
      <div className="text-[12px] text-muted">{label}</div>
      <div className="tnum mt-0.5 text-[20px] font-semibold leading-tight">{value}</div>
      {sub && <div className="tnum mt-0.5 truncate text-[12px] text-faint">{sub}</div>}
      {children}
    </div>
  );
}

function Window({ r }: { r: Extract<Report, { ok: true }> }) {
  const a = r.active;
  if (!a)
    return (
      <p className="rounded-[8px] border border-line bg-base px-3 py-3 text-[13px] text-muted">
        {U().noWindow}
      </p>
    );
  const span = a.end - a.start;
  const elapsed = Math.min(1, Math.max(0, (Date.now() - a.start) / span));
  const left = `${Math.floor(a.leftMin / 60)} ч ${String(a.leftMin % 60).padStart(2, '0')} мин`;
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-testid="usage-window">
      <Tile label={U().inWindow} value={formatTokens(a.tokens)} sub={U().apiPrice(usd(a.costUsd))} />
      <Tile label={U().resetIn} value={left} sub={U().resetAt(hhmm(a.end))}>
        <div
          className="mt-1.5 h-1 overflow-hidden rounded-full bg-hover"
          role="progressbar"
          aria-label={U().windowElapsed}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(elapsed * 100)}
        >
          <div className="h-full rounded-full bg-accent" style={{ width: `${elapsed * 100}%` }} />
        </div>
      </Tile>
      <Tile
        label={U().pace}
        value={a.tpm ? U().perMin(formatTokens(a.tpm)) : '—'}
        sub={a.costPerHour ? U().perHour(usd(a.costPerHour)) : undefined}
      />
      <Tile
        label={U().projected}
        value={a.projectedTokens ? formatTokens(a.projectedTokens) : '—'}
        sub={a.projectedCostUsd ? U().apiPrice(usd(a.projectedCostUsd)) : undefined}
      />
    </div>
  );
}

/** nice round axis maximum and 3 ticks */
function ticks(max: number): number[] {
  if (max <= 0) return [0];
  const p = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 2.5, 5, 10].map((k) => (k * p) / 2).find((s) => s * 3 >= max) ?? p * 5;
  return [0, step, step * 2, step * 3].filter((v, i) => i === 0 || v - step < max);
}

function DailyChart({ daily }: { daily: UsageDay[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = 180;
  const padL = 44;
  const padB = 22;
  const padT = 8;
  const max = Math.max(...daily.map((d) => d.tokens), 1);
  const tk = ticks(max);
  const top = tk[tk.length - 1] ?? max;
  const plotW = W - padL;
  const plotH = H - padB - padT;
  const col = plotW / daily.length;
  const bw = Math.max(3, Math.min(28, col - 2 * Math.max(1, col * 0.18)));
  const y = (v: number) => padT + plotH - (plotH * v) / top;
  const every = daily.length > 14 ? 3 : daily.length > 7 ? 2 : 1;
  const h = hover !== null ? daily[hover] : null;
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full"
        role="img"
        aria-label={U().dailyAria(formatTokens(daily.reduce((n, d) => n + d.tokens, 0)), daily.length)}
        onMouseLeave={() => setHover(null)}
      >
        {tk.map((v) => (
          <g key={v}>
            <line x1={padL} x2={W} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth={1} />
            <text
              x={padL - 6}
              y={y(v) + 4}
              textAnchor="end"
              fontSize={11}
              fill="var(--text-faint)"
              className="tnum"
            >
              {formatTokens(v)}
            </text>
          </g>
        ))}
        {daily.map((d, i) => {
          const x = padL + i * col + (col - bw) / 2;
          const bh = d.tokens > 0 ? Math.max(2, plotH - (y(d.tokens) - padT)) : 0;
          const r = Math.min(4, bw / 2, bh);
          const yt = padT + plotH - bh;
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)}>
              {bh > 0 && (
                <path
                  d={`M${x},${padT + plotH} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + bw - r} Q${x + bw},${yt} ${x + bw},${yt + r} V${padT + plotH} Z`}
                  fill="var(--accent)"
                  opacity={hover === null || hover === i ? 1 : 0.45}
                />
              )}
              {(i % every === (daily.length - 1) % every || i === daily.length - 1) && (
                <text
                  x={padL + i * col + col / 2}
                  y={H - 6}
                  textAnchor="middle"
                  fontSize={11}
                  fill={hover === i ? 'var(--text)' : 'var(--text-faint)'}
                  className="tnum"
                >
                  {dayLabel(d.day)}
                </text>
              )}
              {/* hit target on top: the whole column reacts, not only the bar */}
              <rect x={padL + i * col} y={padT} width={col} height={plotH} fill="transparent" />
            </g>
          );
        })}
        <line
          x1={padL}
          x2={W}
          y1={padT + plotH}
          y2={padT + plotH}
          stroke="var(--border-strong)"
          strokeWidth={1}
        />
      </svg>
      {h && hover !== null && (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-[180px] rounded-[8px] border border-line-strong bg-elevated px-3 py-2 text-[12px] shadow-pop"
          style={{
            left: `${((padL + hover * col + col / 2) / W) * 100}%`,
            transform: hover > daily.length / 2 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
          }}
          role="status"
        >
          <div className="font-semibold">{dayLabel(h.day, true)}</div>
          <div className="tnum mt-1 flex justify-between gap-4">
            <span className="text-muted">{U().tokens}</span>
            {formatTokens(h.tokens)}
          </div>
          <div className="tnum flex justify-between gap-4">
            <span className="text-muted">{U().byApi}</span>
            {usd(h.costUsd)}
          </div>
          {Object.entries(h.models)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([m, v]) => (
              <div key={m} className="tnum flex justify-between gap-4 text-faint">
                <span>{formatModel(m)}</span>
                {formatTokens(v)}
              </div>
            ))}
        </div>
      )}
      <table className="sr-only">
        <caption>{U().byDay}</caption>
        <tbody>
          {daily.map((d) => (
            <tr key={d.day}>
              <th scope="row">{dayLabel(d.day, true)}</th>
              <td>{formatTokens(d.tokens)}</td>
              <td>{usd(d.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Bars({
  rows,
}: {
  rows: { key: string; label: string; tokens: number; costUsd: number; sub?: string }[];
}) {
  const max = Math.max(1, ...rows.map((r) => r.tokens));
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-[12px]">
          <span className="truncate" title={r.sub ? `${r.label} · ${r.sub}` : r.label}>
            {r.label}
          </span>
          <span className="h-2.5 rounded-[3px] bg-hover">
            <span
              className="block h-full rounded-[3px] bg-accent"
              style={{ width: `${Math.max(1, (100 * r.tokens) / max)}%` }}
            />
          </span>
          <span className="tnum w-28 text-right">
            {formatTokens(r.tokens)} <span className="text-faint">· {usd(r.costUsd)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function UsageReportPane() {
  const online = useConn((c) => c.state.kind === 'online');
  const [period, setPeriod] = useState<Period>(7);
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (days: Period, maxAge: number) => {
    setBusy(true);
    try {
      setR(await agent('usage_report', { days, maxAge }));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (online) void load(period, 120);
  }, [online, period, load]);

  const head = (
    <div className="mb-3 flex items-center gap-2">
      <div
        className="flex rounded-[6px] border border-line-strong p-0.5 text-[12px]"
        role="group"
        aria-label={U().period}
      >
        {([7, 14, 30] as const).map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={period === p}
            className={`rounded-[4px] px-2.5 py-0.5 ${period === p ? 'bg-selected font-medium text-fg' : 'text-muted hover:text-fg'}`}
            onClick={() => setPeriod(p)}
          >
            {U().days(p)}
          </button>
        ))}
      </div>
      <span className="flex-1" />
      {r && <span className="text-[12px] text-faint">{t.system.updated(hhmm(r.at))}</span>}
      <Button small onClick={() => void load(period, 0)} disabled={busy || !online}>
        <RefreshCw size={12} className={busy ? 'anim-spin' : ''} aria-hidden />
        {t.system.refresh}
      </Button>
    </div>
  );

  if (!r)
    return (
      <div className="text-[13px] text-muted" role="status">
        {err ? t.info.failed(err) : busy ? U().loading : t.info.loading}
      </div>
    );
  if (!r.ok)
    return (
      <div className="space-y-2 text-[13px]">
        <div>{r.error === 'ccusage не установлен' ? t.system.noCcusage : r.error}</div>
        <code className="selectable inline-block rounded-[4px] border border-line bg-base px-2 py-1 font-mono text-[12px]">
          {t.system.ccusageInstall}
        </code>
      </div>
    );
  const other = U().otherProjects;
  return (
    <div className="space-y-5 text-[13px]" data-testid="usage-report">
      <section>
        <h3 className="mb-2 text-[13px] font-semibold">{t.system.usageWindow}</h3>
        <Window r={r} />
      </section>
      <section>
        {head}
        <div className="mb-1 flex items-baseline gap-2">
          <h3 className="text-[13px] font-semibold">{U().byDay}</h3>
          <span className="tnum text-[12px] text-muted">
            {U().total(formatTokens(r.totalTokens), usd(r.totalCostUsd))}
          </span>
        </div>
        <DailyChart daily={r.daily} />
      </section>
      <div className="grid gap-5 lg:grid-cols-2">
        <section>
          <h3 className="mb-2 text-[13px] font-semibold">{U().byProject}</h3>
          {r.projects.length ? (
            <Bars
              rows={r.projects.map((p) => ({
                key: p.folder ?? '',
                label: p.label ?? other,
                tokens: p.tokens,
                costUsd: p.costUsd,
                sub: U().chats(p.chats),
              }))}
            />
          ) : (
            <p className="text-[12px] text-muted">{U().empty}</p>
          )}
        </section>
        <section>
          <h3 className="mb-2 text-[13px] font-semibold">{U().byModel}</h3>
          {r.models.length ? (
            <Bars
              rows={r.models.map((m) => ({
                key: m.name,
                label: formatModel(m.name),
                tokens: m.tokens,
                costUsd: m.costUsd,
              }))}
            />
          ) : (
            <p className="text-[12px] text-muted">{U().empty}</p>
          )}
        </section>
      </div>
      <p className="text-[12px] leading-snug text-faint">{U().note}</p>
    </div>
  );
}
