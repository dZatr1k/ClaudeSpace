import {
  Circle,
  CircleAlert,
  CircleDashed,
  LoaderCircle,
  MessageCircleQuestion,
  SquareTerminal,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { UiStatus } from '@shared/model';
import { t } from '../../i18n/ru';

const COLOR: Record<UiStatus, string> = {
  busy: 'text-st-busy',
  waiting: 'text-st-waiting',
  idle: 'text-st-idle',
  none: 'text-st-none',
  error: 'text-st-error',
  offline: 'text-st-offline',
};

/**
 * Status is always shape + colour (readable without colour). When the status changes (not on first render, so a
 * scrolled list does not flicker) the icon plays a short «pop» (DESIGN §5.6): the eye lands on the row that changed.
 */
export function StatusIcon({
  status,
  size = 14,
  unknown = false,
}: {
  status: UiStatus;
  size?: number;
  unknown?: boolean;
}) {
  const prev = useRef(status);
  const [pop, setPop] = useState(0);
  useEffect(() => {
    if (prev.current === status) return;
    prev.current = status;
    setPop((n) => n + 1);
  }, [status]);
  const cls = `${unknown ? 'text-st-none' : COLOR[status]} shrink-0`;
  const label = t.status[status] || (status === 'none' ? 'не Claude' : status);
  const p = { size, strokeWidth: 1.9, className: cls, 'aria-hidden': true as const };
  let icon;
  switch (status) {
    case 'busy':
      icon = <LoaderCircle {...p} className={`${cls} anim-spin`} />;
      break;
    case 'waiting':
      icon = <MessageCircleQuestion {...p} className={`${cls} anim-pulse`} />;
      break;
    case 'idle':
      icon = <Circle {...p} fill="currentColor" size={size - 5} />;
      break;
    case 'none':
      icon = <SquareTerminal {...p} />;
      break;
    case 'error':
      icon = <CircleAlert {...p} />;
      break;
    case 'offline':
      icon = <CircleDashed {...p} />;
      break;
  }
  return (
    <span
      key={pop}
      role="img"
      aria-label={label}
      className={`${pop ? 'anim-pop' : ''} inline-flex shrink-0 items-center justify-center`}
      style={{ width: size, height: size }}
    >
      {icon}
    </span>
  );
}
