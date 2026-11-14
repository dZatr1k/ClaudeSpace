// Standalone preview of the startup splash: `npm run splash` -> http://localhost:5180/
// Not part of the app bundle. The state lives in the URL (?s=agent&theme=light&frame=1), so a link reproduces a view.
import '../styles.css';
import './preview.css';
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ConnState } from '@shared/model';
import { Splash } from './Splash';
import type { SplashGears } from './Splash';

const HOST = 'claude@vm';

interface Scene {
  id: string;
  label: string;
  /** state at time `t` since the scene was picked; elapsed = time since "app start" */
  state: (now: number) => ConnState;
  elapsed: number;
}

const SCENES: Scene[] = [
  { id: 'idle', label: 'Запуск', elapsed: 0, state: () => ({ kind: 'idle' }) },
  {
    id: 'config',
    label: 'Настройки SSH',
    elapsed: 200,
    state: () => ({ kind: 'connecting', step: 'config', attempt: 1 }),
  },
  {
    id: 'hostkey',
    label: 'Ключ хоста',
    elapsed: 700,
    state: () => ({ kind: 'connecting', step: 'hostkey', attempt: 1 }),
  },
  {
    id: 'auth',
    label: 'Вход',
    elapsed: 1200,
    state: () => ({ kind: 'connecting', step: 'auth', attempt: 1 }),
  },
  {
    id: 'agent',
    label: 'Агент',
    elapsed: 2000,
    state: () => ({ kind: 'connecting', step: 'agent', attempt: 1 }),
  },
  {
    id: 'install',
    label: 'Установка агента',
    elapsed: 3500,
    state: () => ({ kind: 'connecting', step: 'agent', attempt: 1, detail: 'Установка агента (184 КБ)…' }),
  },
  {
    id: 'slow',
    label: 'Долго (>15 с)',
    elapsed: 18_000,
    state: () => ({ kind: 'connecting', step: 'auth', attempt: 1 }),
  },
  {
    id: 'retry',
    label: 'Повторная попытка',
    elapsed: 9000,
    state: () => ({ kind: 'connecting', step: 'auth', attempt: 3 }),
  },
  {
    id: 'offline',
    label: 'Нет связи',
    elapsed: 6000,
    state: (now) => ({
      kind: 'offline',
      since: now - 6000,
      retryAt: now + 5000,
      attempt: 2,
      error: 'connect ETIMEDOUT 78.17.17.82:22',
    }),
  },
  {
    id: 'online',
    label: 'Готово',
    elapsed: 2600,
    state: (now) => ({ kind: 'online', since: now, rttMs: 42, agent: '0.3.0', host: HOST }),
  },
];

/** "play": a realistic first connect, then online and fade-out */
const RUN: { at: number; state: ConnState }[] = [
  { at: 0, state: { kind: 'idle' } },
  { at: 250, state: { kind: 'connecting', step: 'config', attempt: 1 } },
  { at: 450, state: { kind: 'connecting', step: 'auth', attempt: 1 } },
  { at: 900, state: { kind: 'connecting', step: 'hostkey', attempt: 1 } },
  { at: 1100, state: { kind: 'connecting', step: 'auth', attempt: 1 } },
  { at: 1700, state: { kind: 'connecting', step: 'agent', attempt: 1 } },
  {
    at: 2600,
    state: { kind: 'online', since: 0, rttMs: 42, agent: '0.3.0', host: HOST },
  },
];

/** sliders for the "behind the logo" gears: CSS custom properties read by splash.css */
const KNOBS = [
  {
    id: 'go',
    label: 'Яркость',
    css: '--splash-gears-opacity',
    min: 0.03,
    max: 0.6,
    step: 0.01,
    def: 0.1,
    fmt: (v: number) => v.toFixed(2),
  },
  {
    id: 'gf',
    label: 'Растушёвка',
    css: '--splash-gears-fade',
    min: 0,
    max: 95,
    step: 1,
    def: 0,
    fmt: (v: number) => `${v}%`,
  },
  {
    id: 'gsz',
    label: 'Размер',
    css: '--splash-gears-size',
    min: 0.6,
    max: 2.5,
    step: 0.05,
    def: 2.5,
    fmt: (v: number) => v.toFixed(2),
  },
  {
    id: 'gsp',
    label: 'Оборот',
    css: '--splash-gears-speed',
    min: 1,
    max: 12,
    step: 0.5,
    def: 12,
    fmt: (v: number) => `${v}s`,
  },
];

function readUrl() {
  const q = new URLSearchParams(location.search);
  return {
    scene: q.get('s') ?? 'agent',
    theme: (q.get('theme') === 'light' ? 'light' : 'dark') as 'dark' | 'light',
    frame: q.get('frame') !== '0',
    size: q.get('size') ?? 'full',
    freeze: q.get('freeze') === '1',
    gears: (q.get('gears') ?? 'behind') as SplashGears,
    knobs: Object.fromEntries(KNOBS.map((k) => [k.id, Number(q.get(k.id) ?? k.def)])) as Record<
      string,
      number
    >,
    accent: q.get('accent') !== '0',
  };
}

const SIZES: Record<string, [number, number] | null> = {
  full: null,
  '1280×800': [1280, 800],
  '960×600': [960, 600],
  '720×480': [720, 480],
};

function Preview() {
  const [cfg, setCfg] = useState(readUrl);
  const [base, setBase] = useState(() => Date.now()); // when the scene was picked
  const [run, setRun] = useState<{ start: number; state: ConnState; leaving: boolean } | null>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    document.documentElement.dataset.theme = cfg.theme;
    const q = new URLSearchParams({
      s: cfg.scene,
      theme: cfg.theme,
      frame: cfg.frame ? '1' : '0',
      size: cfg.size,
      gears: cfg.gears,
      accent: cfg.accent ? '1' : '0',
      ...Object.fromEntries(KNOBS.map((k) => [k.id, String(cfg.knobs[k.id])])),
      ...(cfg.freeze ? { freeze: '1' } : {}),
    });
    history.replaceState(null, '', `?${q}`);
  }, [cfg]);

  const stopRun = () => {
    for (const id of timers.current) clearTimeout(id);
    timers.current = [];
    setRun(null);
  };

  const play = () => {
    stopRun();
    const start = Date.now();
    setRun({ start, state: (RUN[0] as (typeof RUN)[number]).state, leaving: false });
    for (const step of RUN)
      timers.current.push(window.setTimeout(() => setRun((r) => r && { ...r, state: step.state }), step.at));
    const end = Math.max(...RUN.map((r) => r.at));
    timers.current.push(window.setTimeout(() => setRun((r) => r && { ...r, leaving: true }), end + 450));
  };

  const pick = (id: string) => {
    stopRun();
    setBase(Date.now());
    setCfg((c) => ({ ...c, scene: id }));
  };

  const scene = SCENES.find((s) => s.id === cfg.scene) ?? (SCENES[0] as Scene);
  const props = run
    ? { state: run.state, startedAt: run.start, leaving: run.leaving }
    : { state: scene.state(base), startedAt: base - scene.elapsed, now: cfg.freeze ? base : undefined };
  const size = SIZES[cfg.size];

  return (
    <div className="pv">
      <div
        className={`pv-stage ${size ? 'is-sized' : ''}`}
        style={{
          ...(size ? { width: size[0], height: size[1] } : {}),
          ...Object.fromEntries(KNOBS.map((k) => [k.css, k.fmt(cfg.knobs[k.id] ?? k.def)])),
        }}
      >
        {cfg.frame && (
          <div className="pv-titlebar">
            <span className="pv-titlebar__btn">─</span>
            <span className="pv-titlebar__btn">▢</span>
            <span className="pv-titlebar__btn">✕</span>
          </div>
        )}
        {run?.leaving && (
          <div className="pv-app">
            тут откроется главное окно · <button onClick={play}>ещё раз</button>
          </div>
        )}
        <Splash
          key={run ? `run-${run.start}` : `scene-${scene.id}`}
          host={HOST}
          {...props}
          onRetry={() => pick('agent')}
          gears={cfg.gears}
          gearsAccent={cfg.accent}
          onSkip={() => alert('Открыть без связи: главное окно с данными из кэша')}
        />
      </div>

      <aside className="pv-panel">
        <div className="pv-panel__title">Загрузочный экран</div>
        <button className="pv-play" onClick={play}>
          ▶ Прогон подключения
        </button>
        <div className="pv-group">
          {SCENES.map((s) => (
            <button
              key={s.id}
              className={!run && s.id === cfg.scene ? 'is-on' : ''}
              onClick={() => pick(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="pv-row">
          <span>Вид</span>
          {(
            [
              ['below', 'под логотипом'],
              ['inline', 'у текста'],
              ['behind', 'фоном за ◆'],
              ['none', 'без них'],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              className={cfg.gears === m ? 'is-on' : ''}
              onClick={() => setCfg((c) => ({ ...c, gears: m }))}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="pv-check">
          <input
            type="checkbox"
            checked={cfg.accent}
            onChange={(e) => setCfg((c) => ({ ...c, accent: e.target.checked }))}
          />
          большая шестерня оранжевая
        </label>
        {cfg.gears === 'behind' && (
          <div className="pv-knobs">
            {KNOBS.map((k) => (
              <label key={k.id} className="pv-knob">
                <span>{k.label}</span>
                <input
                  type="range"
                  min={k.min}
                  max={k.max}
                  step={k.step}
                  value={cfg.knobs[k.id] ?? k.def}
                  onChange={(e) =>
                    setCfg((c) => ({ ...c, knobs: { ...c.knobs, [k.id]: Number(e.target.value) } }))
                  }
                />
                <code>{k.fmt(cfg.knobs[k.id] ?? k.def)}</code>
              </label>
            ))}
            <button
              onClick={() =>
                setCfg((c) => ({ ...c, knobs: Object.fromEntries(KNOBS.map((k) => [k.id, k.def])) }))
              }
            >
              сбросить
            </button>
          </div>
        )}
        <div className="pv-row">
          <span>Тема</span>
          {(['dark', 'light'] as const).map((th) => (
            <button
              key={th}
              className={cfg.theme === th ? 'is-on' : ''}
              onClick={() => setCfg((c) => ({ ...c, theme: th }))}
            >
              {th === 'dark' ? 'тёмная' : 'светлая'}
            </button>
          ))}
        </div>
        <div className="pv-row">
          <span>Окно</span>
          {Object.keys(SIZES).map((k) => (
            <button
              key={k}
              className={cfg.size === k ? 'is-on' : ''}
              onClick={() => setCfg((c) => ({ ...c, size: k }))}
            >
              {k === 'full' ? 'вся вкладка' : k}
            </button>
          ))}
        </div>
        <label className="pv-check">
          <input
            type="checkbox"
            checked={cfg.frame}
            onChange={(e) => setCfg((c) => ({ ...c, frame: e.target.checked }))}
          />
          кнопки окна Windows
        </label>
        <label className="pv-check">
          <input
            type="checkbox"
            checked={cfg.freeze}
            onChange={(e) => setCfg((c) => ({ ...c, freeze: e.target.checked }))}
          />
          остановить таймеры
        </label>
        <div className="pv-hint">H скрывает панель</div>
      </aside>
    </div>
  );
}

window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'h' || e.key.toLowerCase() === 'р') document.body.classList.toggle('pv-hide');
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
