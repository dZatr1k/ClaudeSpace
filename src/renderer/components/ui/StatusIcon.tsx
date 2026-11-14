import {
  Circle,
  CircleAlert,
  CircleDashed,
  LoaderCircle,
  MessageCircleQuestion,
  SquareTerminal,
} from 'lucide-react';
import type { UiStatus } from '@shared/model';

const COLOR: Record<UiStatus, string> = {
  busy: 'text-st-busy',
  waiting: 'text-st-waiting',
  idle: 'text-st-idle',
  none: 'text-st-none',
  error: 'text-st-error',
  offline: 'text-st-offline',
};

/** Status is always shape + colour (readable without colour). */
export function StatusIcon({
  status,
  size = 14,
  unknown = false,
}: {
  status: UiStatus;
  size?: number;
  unknown?: boolean;
}) {
  const cls = `${unknown ? 'text-st-none' : COLOR[status]} shrink-0`;
  const p = { size, strokeWidth: 1.75, className: cls, 'aria-label': status };
  switch (status) {
    case 'busy':
      return <LoaderCircle {...p} className={`${cls} anim-spin`} />;
    case 'waiting':
      return <MessageCircleQuestion {...p} className={`${cls} anim-pulse`} />;
    case 'idle':
      return <Circle {...p} fill="currentColor" size={size - 4} />;
    case 'none':
      return <SquareTerminal {...p} />;
    case 'error':
      return <CircleAlert {...p} />;
    case 'offline':
      return <CircleDashed {...p} />;
  }
}
