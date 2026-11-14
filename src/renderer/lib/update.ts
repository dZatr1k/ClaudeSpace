import type { UpdateState } from '@shared/update';
import { t } from '../i18n/ru';

/** one line for Settings → О программе */
export function updateStatusText(s: UpdateState): string {
  const v = s.version ?? '?';
  switch (s.status) {
    case 'disabled':
      return s.disabledReason === 'platform' ? t.update.disabledPlatform : t.update.disabledDev;
    case 'idle':
      return t.update.idle;
    case 'checking':
      return t.update.checking;
    case 'none':
      return t.update.none;
    case 'available':
      return t.update.available(v);
    case 'downloading':
      return t.update.downloading(v, s.percent ?? 0);
    case 'ready':
      return t.update.readyStatus(v);
    case 'error':
      return t.update.error(s.error ?? '?');
  }
}
