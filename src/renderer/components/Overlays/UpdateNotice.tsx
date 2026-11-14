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
      className="fixed bottom-8 left-4 z-[60] flex max-w-[420px] items-start gap-2 rounded-[8px] border border-line-strong bg-elevated px-3 py-2 text-[13px] shadow-float"
    >
      <Download size={16} className="mt-0.5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <div>{t.update.ready(st.version)}</div>
        <div className="mt-0.5 text-[12px] text-faint">{t.update.laterHint}</div>
        <div className="mt-2 flex gap-2">
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
