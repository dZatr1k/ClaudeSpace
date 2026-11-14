// Startup splash: shown from app start until the first connection to the VM is up (or fails in a way the
// connection screen has to handle). Purely presentational: everything comes in through props, so the same
// component runs in the app and in the standalone preview (npm run splash, see splash/preview.tsx).
import { useEffect, useState } from 'react';
import type { ConnState } from '@shared/model';
import { Gearbox } from './Gearbox';
import './splash.css';

/** where the gear animation sits; the ◆ logo is always there */
export type SplashGears = 'below' | 'inline' | 'behind' | 'none';

export interface SplashProps {
  state: ConnState;
  /** "claude@vm" or the ssh Host alias */
  host: string;
  /** when the app started (ms): drives the elapsed timer */
  startedAt: number;
  /** override the clock (preview: freeze a moment) */
  now?: number;
  /** fade-out after the connection is up */
  leaving?: boolean;
  onRetry?: () => void;
  onSkip?: () => void;
  gears?: SplashGears;
  /** big gear in the accent colour */
  gearsAccent?: boolean;
}

type Phase = 0 | 1 | 2 | 3; // 3 = done
const PHASES = ['Настройки', 'Вход', 'Агент'] as const;

function phaseOf(s: ConnState): Phase {
  if (s.kind === 'online') return 3;
  if (s.kind === 'offline') return 1; // network/ssh failure: the "Вход" stage failed
  if (s.kind !== 'connecting') return 0;
  return s.step === 'config' ? 0 : s.step === 'agent' ? 2 : 1;
}

function headline(s: ConnState, host: string): string {
  switch (s.kind) {
    case 'idle':
      return 'Запуск';
    case 'connecting':
      if (s.step === 'config') return 'Читаю настройки SSH';
      if (s.step === 'hostkey') return 'Проверяю ключ VM';
      if (s.step === 'auth') return `Вхожу на ${host}`;
      return s.detail ?? 'Запускаю агент на VM';
    case 'online':
      return 'Готово';
    case 'offline':
      return 'VM не отвечает';
    case 'needs-user':
      return 'Нужно ваше действие';
  }
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function useNow(frozen?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (frozen !== undefined) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [frozen]);
  return frozen ?? now;
}

export function Splash({
  state,
  host,
  startedAt,
  now: frozen,
  leaving,
  onRetry,
  onSkip,
  gears = 'behind',
  gearsAccent = true,
}: SplashProps) {
  const now = useNow(frozen);
  const phase = phaseOf(state);
  const offline = state.kind === 'offline';
  const elapsed = now - startedAt;
  const attempt = state.kind === 'connecting' || offline ? state.attempt : 1;
  const slow = state.kind === 'connecting' && elapsed > 15_000;
  const gearbox = <Gearbox accent={gearsAccent} state={offline ? 'paused' : phase === 3 ? 'done' : 'run'} />;
  const retryIn = offline ? Math.max(0, Math.ceil((state.retryAt - now) / 1000)) : 0;

  return (
    <div
      className={`cs-splash ${leaving ? 'is-leaving' : ''} ${offline ? 'is-offline' : ''} ${phase === 3 ? 'is-done' : ''}`}
      data-testid="splash"
      role="status"
      aria-live="polite"
    >
      <div className="cs-splash__drag" />
      <div className="cs-splash__body">
        <div className="cs-splash__mark" aria-hidden>
          {gears === 'behind' && <div className="cs-splash__gears is-behind">{gearbox}</div>}
          <span className="cs-splash__ring" />
          <span className="cs-splash__diamond">◆</span>
        </div>
        <div className="cs-splash__name">ClaudeSpace</div>

        {gears === 'below' && <div className="cs-splash__gears is-below">{gearbox}</div>}

        <div className="cs-splash__headline">
          {gears === 'inline' && <span className="cs-splash__gears is-inline">{gearbox}</span>}
          {headline(state, host)}
        </div>

        <ol className="cs-splash__steps" aria-label="Этапы подключения">
          {PHASES.map((label, i) => {
            const st =
              offline && i === phase ? 'failed' : i < phase ? 'done' : i === phase ? 'active' : 'todo';
            return (
              <li key={label} className={`cs-splash__step is-${st}`}>
                <span className="cs-splash__bar" />
                <span className="cs-splash__label">{label}</span>
              </li>
            );
          })}
        </ol>

        <div className="cs-splash__meta">
          <span className="cs-splash__host">{host}</span>
          {elapsed > 4000 && phase < 3 && <span className="cs-splash__clock">{clock(elapsed)}</span>}
          {attempt > 1 && <span>попытка {attempt}</span>}
        </div>

        {slow && <div className="cs-splash__hint">Дольше обычного. Возможно, VM ещё загружается.</div>}

        {offline && (
          <div className="cs-splash__offline">
            <div className="cs-splash__error">{state.error}</div>
            <div className="cs-splash__retry">{retryIn > 0 ? `Повтор через ${retryIn} с` : 'Повторяю…'}</div>
            <div className="cs-splash__actions">
              <button className="cs-splash__btn is-primary" onClick={onRetry}>
                Повторить сейчас
              </button>
              <button className="cs-splash__btn" onClick={onSkip}>
                Открыть без связи
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
