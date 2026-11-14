import { Cpu, Gauge, Stethoscope } from 'lucide-react';
import { useState } from 'react';
import { t } from '../../i18n/ru';
import { formatAgo, formatLeft, formatTokens } from '../../lib/format';
import { useConn } from '../../stores/conn';
import { useData } from '../../stores/data';
import { useUi } from '../../stores/ui';
import { ConnDot, ConnPopover } from '../TitleBar/TitleBar';
import { PcLinkIndicator } from './PcLinkIndicator';

export function StatusBar() {
  const conn = useConn((c) => c.state);
  const system = useData((d) => d.system);
  const doctor = useData((d) => d.doctor);
  const usage = useData((d) => d.usage);
  const sessions = useData((d) => d.sessions);
  const hello = useData((d) => d.hello);
  const staleAt = useData((d) => d.staleAt);
  const online = conn.kind === 'online';
  const [pop, setPop] = useState(false);
  const waiting = sessions.filter((s) => s.claude.some((c) => c.status === 'waiting')).length;
  const staleTip = !online && staleAt ? t.statusBar.staleHint(formatAgo(staleAt)) : undefined;
  const ver = system?.claudeVersion ?? hello?.claudeVersion ?? null;
  const dLevel = doctor?.level;
  const dText =
    dLevel === 'error'
      ? t.statusBar.doctorError
      : dLevel === 'warn'
        ? t.statusBar.doctorWarn
        : dLevel === 'ok'
          ? t.statusBar.doctorOk
          : '';
  const dColor =
    dLevel === 'error' ? 'text-st-error' : dLevel === 'warn' ? 'text-st-waiting' : 'text-st-idle';
  const block = usage?.block;
  const item = 'flex h-full items-center gap-1 px-2 hover:bg-hover cursor-default';
  return (
    <footer
      className={`relative flex h-6 shrink-0 items-center border-t border-line bg-surface text-[12px] text-muted tnum ${online ? '' : 'grayscale'}`}
    >
      <button className={item} onClick={() => setPop((p) => !p)} data-testid="status-conn">
        <ConnDot />
        <span>{hello?.host ?? 'vm'}</span>
      </button>
      {pop && <ConnPopover where="status" onClose={() => setPop(false)} />}
      <span className="h-3 w-px bg-line" />
      <button
        className={`${item} ${online ? '' : 'opacity-60'}`}
        title={staleTip}
        onClick={() => useUi.getState().set({ system: 'resources' })}
      >
        <Cpu size={13} />
        {system ? `CPU ${system.cpuPct}% · RAM ${system.memPct}% · диск ${system.diskPct}%` : '—'}
      </button>
      <span className="h-3 w-px bg-line" />
      <button
        className={`${item} ${online ? '' : 'opacity-60'}`}
        title={doctor?.message ?? staleTip}
        onClick={() => useUi.getState().set({ system: 'doctor' })}
      >
        <Stethoscope size={13} />
        Claude {ver ?? '?'} <span className={dColor}>{dText}</span>
      </button>
      <span className="h-3 w-px bg-line" />
      <button
        className={`${item} ${online ? '' : 'opacity-60'}`}
        title={staleTip}
        onClick={() => useUi.getState().set({ system: 'usage' })}
      >
        <Gauge size={13} />
        {block
          ? t.statusBar.usageWindow(formatTokens(block.tokens), formatLeft(block.leftMin))
          : t.statusBar.noUsage}
      </button>
      <span className="flex-1" />
      <PcLinkIndicator className={item} />
      <span className="h-3 w-px bg-line" />
      <span className={`px-2 ${waiting ? 'text-st-waiting' : ''}`}>
        {t.statusBar.sessions(sessions.length, waiting)}
      </span>
    </footer>
  );
}
