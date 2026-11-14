// «Порты» (BACKLOG 10): ports the user's processes listen on at the VM; open in the PC browser, forward/close,
// copy the URL, pin (re-forwarded on every connect).
import { Copy, ExternalLink, Pin, PinOff, Plug, Unplug, WifiOff } from 'lucide-react';
import type { VmPort } from '@shared/protocol';
import type { ForwardInfo } from '@shared/ports';
import { invoke } from '../../bridge';
import { t } from '../../i18n/ru';
import { forwardVmPort, openVmPort } from '../../lib/ports';
import { useConn } from '../../stores/conn';
import { useData } from '../../stores/data';
import { usePorts } from '../../stores/ports';
import { useUi } from '../../stores/ui';
import { IconButton } from '../ui/Button';

async function setPinned(port: number, on: boolean) {
  const s = useUi.getState().settings;
  if (!s) return;
  const cur = s.ports.pinned.filter((p) => p !== port);
  const next = await invoke('settings.set', {
    ports: { pinned: on ? [...cur, port].sort((a, b) => a - b) : cur },
  });
  useUi.getState().set({ settings: next });
}

async function copyUrl(port: number) {
  const r = await invoke('ports.forward', { vmPort: port });
  if (!r.ok) return useUi.getState().toast(t.ports.failed(r.error), 'error');
  await invoke('clipboard.write', { text: r.url });
  useUi.getState().toast(t.ports.copied(r.url), 'success');
}

function Row({
  port,
  vm,
  fwd,
  pinned,
  online,
}: {
  port: number;
  vm: VmPort | null;
  fwd: ForwardInfo | null;
  pinned: boolean;
  online: boolean;
}) {
  const sub = [
    vm?.addr,
    fwd && !fwd.direct ? t.ports.forwardedTo(fwd.localPort) : null,
    fwd?.conns ? t.ports.conns(fwd.conns) : null,
    pinned ? t.ports.pinned : null,
  ].filter(Boolean);
  return (
    <div
      className={`group flex items-center gap-1 px-4 py-1.5 hover:bg-hover ${vm ? '' : 'opacity-70'}`}
      data-port={port}
      title={vm?.cwd ?? undefined}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-[13px]">
          <span className="tnum font-mono font-semibold">:{port}</span>
          <span className="truncate text-muted">{[vm?.name, vm?.project].filter(Boolean).join(' · ')}</span>
        </div>
        {sub.length > 0 && (
          <div
            className={`truncate text-[12px] ${fwd && fwd.localPort !== port ? 'text-st-waiting' : 'text-faint'}`}
          >
            {sub.join(' · ')}
          </div>
        )}
      </div>
      <IconButton title={t.ports.open} disabled={!online} onClick={() => void openVmPort(port)}>
        <ExternalLink size={14} aria-hidden />
      </IconButton>
      {fwd && !fwd.direct ? (
        <IconButton title={t.ports.close} onClick={() => void invoke('ports.close', { vmPort: port })}>
          <Unplug size={14} aria-hidden />
        </IconButton>
      ) : (
        <IconButton
          title={t.ports.forward}
          disabled={!online || !!fwd?.direct}
          onClick={() => void forwardVmPort(port)}
        >
          <Plug size={14} aria-hidden />
        </IconButton>
      )}
      <IconButton title={t.ports.copy} disabled={!online} onClick={() => void copyUrl(port)}>
        <Copy size={14} aria-hidden />
      </IconButton>
      <IconButton
        title={pinned ? t.ports.unpin : t.ports.pin}
        active={pinned}
        onClick={() => void setPinned(port, !pinned)}
      >
        {pinned ? <PinOff size={14} aria-hidden /> : <Pin size={14} aria-hidden />}
      </IconButton>
    </div>
  );
}

export function PortsPanel() {
  const ports = useData((d) => d.ports);
  const forwards = usePorts((p) => p.forwards);
  const pinned = useUi((u) => u.settings?.ports.pinned ?? []);
  const online = useConn((c) => c.state.kind === 'online');
  const vmBy = new Map(ports.map((p) => [p.port, p]));
  const fwdBy = new Map(forwards.map((f) => [f.vmPort, f]));
  const all = [
    ...new Set([...(online ? ports.map((p) => p.port) : []), ...forwards.map((f) => f.vmPort), ...pinned]),
  ];
  all.sort((a, b) => a - b);
  return (
    <div className="min-h-0 flex-1 overflow-auto py-3" data-ports-panel>
      <div className="px-4 pb-3 text-[12px] leading-relaxed text-faint">{t.ports.hint}</div>
      {!online && (
        <div className="mx-4 mb-2 flex items-start gap-2 text-[12px] text-muted" role="status">
          <WifiOff size={13} className="mt-0.5 shrink-0 text-st-error" aria-hidden />
          {t.ports.offline}
        </div>
      )}
      {online && all.length === 0 && (
        <div className="mx-4 rounded-[6px] border border-dashed border-line-strong p-3 text-[12px] leading-relaxed text-muted">
          {t.ports.empty}
        </div>
      )}
      {all.map((p) => (
        <Row
          key={p}
          port={p}
          vm={online ? (vmBy.get(p) ?? null) : null}
          fwd={fwdBy.get(p) ?? null}
          pinned={pinned.includes(p)}
          online={online}
        />
      ))}
    </div>
  );
}
