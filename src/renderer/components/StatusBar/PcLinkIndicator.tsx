// Status bar: «ПК: туннель ✓ · диск V ✓» (BACKLOG 12) with a menu: mount/unmount, reconnect the tunnel, settings.
import { HardDrive, Monitor, RefreshCw, Settings as Cog } from 'lucide-react';
import type { PcLinkState, PcMountState } from '@shared/pclink';
import { invoke } from '../../bridge';
import { t } from '../../i18n/ru';
import { usePcLink } from '../../stores/pclink';
import { useUi } from '../../stores/ui';
import { DropdownMenu } from '../ui/Menu';
import type { MenuEntry } from '../ui/Menu';

function mountMark(m: PcMountState): string {
  if (m.busy) return '…';
  if (m.error && !m.mounted) return '✕';
  return m.mounted ? '✓' : '○';
}

export function pcLinkText(s: PcLinkState): string {
  const parts = [t.pclink[`tunnel_${s.tunnel}`]];
  if (s.sshd === 'down' && (s.tunnel === 'ours' || s.tunnel === 'foreign')) parts.push(t.pclink.sshdDown);
  for (const m of s.mounts) parts.push(t.pclink.disk(m.label, mountMark(m)));
  return t.pclink.prefix(parts.join(' · '));
}

function tone(s: PcLinkState): string {
  if (s.tunnel === 'error' || s.mounts.some((m) => m.error && !m.mounted)) return 'text-st-error';
  if (s.tunnel === 'busy' || s.sshd === 'down') return 'text-st-waiting';
  return '';
}

function tip(s: PcLinkState): string {
  const lines = [pcLinkText(s)];
  if (s.detail) lines.push(s.detail);
  if (s.nextTryAt && s.tunnel !== 'ours')
    lines.push(t.pclink.retryIn(Math.max(0, Math.round((s.nextTryAt - Date.now()) / 1000))));
  if (s.sshd === 'down') lines.push(t.pclink.sshdDownHint);
  if (s.conns) lines.push(t.pclink.conns(s.conns));
  for (const m of s.mounts) {
    lines.push(
      `${m.src} → ${m.dst}${m.mounted && !m.owned ? ` (${m.other ? t.pclink.other : t.pclink.manual})` : ''}${m.error ? `: ${m.error}` : ''}`,
    );
  }
  return lines.join('\n');
}

async function toggleMount(m: PcMountState) {
  const ui = useUi.getState();
  const r = m.mounted
    ? await invoke('pclink.unmount', { dst: m.dst })
    : await invoke('pclink.mount', { dst: m.dst });
  if (r.ok) ui.toast(m.mounted ? t.pclink.unmounted(m.label) : t.pclink.mounted(m.label, m.dst), 'success');
  else ui.toast(t.pclink.failed(m.label, r.error ?? ''), 'error', undefined, 8000);
}

export function PcLinkIndicator({ className }: { className: string }) {
  const s = usePcLink((p) => p.state);
  if (s.tunnel === 'local') return null;
  const online = s.tunnel !== 'waiting';
  const items: MenuEntry[] = [
    ...s.mounts.map((m): MenuEntry => ({
      label: m.mounted
        ? m.owned
          ? t.pclink.unmount(m.label)
          : m.other
            ? t.pclink.unmountOther(m.label)
            : t.pclink.unmountManual(m.label)
        : t.pclink.mount(m.label),
      hint: m.src,
      icon: <HardDrive size={13} />,
      disabled: !online || !!m.busy,
      run: () => void toggleMount(m),
    })),
    ...(s.mounts.length ? (['sep'] as MenuEntry[]) : []),
    {
      label: t.pclink.reconnect,
      icon: <RefreshCw size={13} />,
      disabled: !online || s.tunnel === 'off',
      run: () => void invoke('pclink.reconnect'),
    },
    {
      label: t.pclink.settings,
      icon: <Cog size={13} />,
      run: () => useUi.getState().set({ settingsOpen: 'pclink' }),
    },
  ];
  return (
    <DropdownMenu
      items={items}
      trigger={
        <button className={`${className} ${tone(s)}`} title={tip(s)} data-testid="status-pclink">
          <Monitor size={13} aria-hidden />
          {pcLinkText(s)}
        </button>
      }
    />
  );
}
