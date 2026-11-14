// Shared bits of the right panel tabs: agent loading with retry, the loading skeleton, the error line.
import { CircleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { t } from '../../i18n/ru';
import { useConn } from '../../stores/conn';

export type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; data: T };

export function useAgentLoad<T>(
  key: string | null,
  fn: () => Promise<T>,
  deps: unknown[],
): [Load<T>, () => void] {
  const [st, setSt] = useState<Load<T>>({ state: 'loading' });
  const [n, setN] = useState(0);
  const online = useConn((c) => c.state.kind === 'online');
  useEffect(() => {
    if (!key) return;
    let alive = true;
    if (!online) {
      setSt({ state: 'error', message: t.toasts.offlineAction });
      return;
    }
    setSt((s) => (s.state === 'ok' ? s : { state: 'loading' }));
    fn().then(
      (data) => alive && setSt({ state: 'ok', data }),
      (e: Error) => alive && setSt({ state: 'error', message: e.message }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, n, online, ...deps]);
  return [st, () => setN((x) => x + 1)];
}

export function Skeleton() {
  return (
    <div className="space-y-2 p-4" role="status" aria-label={t.info.loading}>
      {[80, 60, 70, 40].map((w, i) => (
        <div
          key={i}
          className="h-3 rounded-[4px] bg-hover motion-safe:animate-pulse"
          style={{ width: `${w}%` }}
        />
      ))}
      <div className="pt-1 text-[12px] text-faint">{t.info.loading}</div>
    </div>
  );
}

export function ErrorLine({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="flex items-start gap-2 p-4 text-[12px]" role="alert">
      <CircleAlert size={14} className="mt-0.5 shrink-0 text-st-error" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="text-fg">{t.info.failed(message)}</span>{' '}
        <button className="font-medium text-accent-text hover:underline" onClick={retry}>
          {t.actions.retry}
        </button>
      </span>
    </div>
  );
}
