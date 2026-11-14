// A downloaded update: a small card above the status bar — «restart and update» or «later» (installs on quit).
import { Download } from 'lucide-react';
import { useState } from 'react';
import { invoke } from '../../bridge';
import { t } from '../../i18n/ru';
import { useUpdate } from '../../stores/update';
import { useUi } from '../../stores/ui';
import { Button } from '../ui/Button';

export function restartAndUpdate(): void {
  void invoke('update.install').then((r) => {
    if (!r.ok) useUi.getState().toast(t.update.installFailed, 'error');
  });
}

export function UpdateNotice() {
  const st = useUpdate((u) => u.state);
  const dismissed = useUpdate((u) => u.dismissed);
  const [busy, setBusy] = useState(false);
  if (st.status !== 'ready' || !st.version || dismissed === st.version) return null;
  return (
    <div
      role="status"
      data-update-notice
      className="anim-slide-l fixed bottom-8 left-4 z-[60] flex max-w-[400px] items-start gap-3 rounded-[10px] border border-line-strong bg-elevated p-3.5 text-[13px] shadow-pop"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-accent text-accent-fg">
        <Download size={16} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{t.update.ready(st.version)}</div>
        <div className="mt-0.5 text-[12px] leading-snug text-muted">{t.update.laterHint}</div>
        <div className="mt-3 flex gap-2">
          <Button
            small
            variant="primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              restartAndUpdate();
            }}
          >
            {t.update.restart}
          </Button>
          <Button small onClick={() => useUpdate.getState().dismiss(st.version ?? '')}>
            {t.update.later}
          </Button>
        </div>
      </div>
    </div>
  );
}
