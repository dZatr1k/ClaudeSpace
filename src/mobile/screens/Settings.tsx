// Settings: the connection (saving reconnects), the phone key, the theme and the terminal font.
import { ChevronLeft, Minus, Plus } from 'lucide-react';
import { MOBILE_FONT_MAX, MOBILE_FONT_MIN } from '@shared/mobile';
import type { MobileSettings } from '@shared/mobile';
import { useData } from '../../renderer/stores/data';
import { invoke } from '../bridge';
import { m } from '../strings';
import { back, useApp } from '../store';
import { IconButton, KeyBlock, SectionTitle } from '../ui';
import { SetupForm } from './Connect';

const THEMES: MobileSettings['appearance']['theme'][] = ['system', 'dark', 'light'];

async function setAppearance(p: Partial<MobileSettings['appearance']>) {
  const s = await invoke('settings.set', { appearance: p });
  useApp.getState().set({ settings: s });
}

export function Settings() {
  const settings = useApp((s) => s.settings);
  const agentVersion = useData((d) => d.hello?.agent ?? null);
  if (!settings) return null;
  const { theme, fontSize } = settings.appearance;
  return (
    <div className="safe flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-line bg-surface pr-3">
        <IconButton label={m.chat.back} onClick={back}>
          <ChevronLeft size={24} strokeWidth={1.75} aria-hidden />
        </IconButton>
        <h1 className="text-[16px] font-semibold">{m.settings.title}</h1>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto pb-10">
        <div className="mx-auto max-w-lg">
          <SectionTitle>{m.settings.connection}</SectionTitle>
          <div className="px-4">
            <SetupForm
              className="mt-1"
              submit={m.settings.save}
              onDone={() => useApp.getState().toast(m.settings.saved, 'success', 2500)}
            />
          </div>
          <div className="px-4 pt-6">
            <KeyBlock />
          </div>

          <SectionTitle>{m.settings.appearance}</SectionTitle>
          <div className="px-4">
            <div className="text-[14px] text-muted" id="theme-label">
              {m.settings.theme}
            </div>
            <div
              role="radiogroup"
              aria-labelledby="theme-label"
              className="mt-1 grid grid-cols-3 gap-1 rounded-[6px] border border-line-strong p-1"
            >
              {THEMES.map((x) => (
                <button
                  key={x}
                  type="button"
                  role="radio"
                  aria-checked={theme === x}
                  className={`min-h-11 rounded-[4px] text-[14px] ${theme === x ? 'bg-selected font-medium text-fg' : 'text-muted active:bg-hover'}`}
                  onClick={() => void setAppearance({ theme: x })}
                >
                  {m.settings.themes[x]}
                </button>
              ))}
            </div>
            <div className="mt-5 flex items-center gap-3">
              <span className="flex-1 text-[15px]">{m.settings.font}</span>
              <IconButton
                label={m.settings.smaller}
                className="border border-control"
                disabled={fontSize <= MOBILE_FONT_MIN}
                onClick={() => void setAppearance({ fontSize: fontSize - 1 })}
              >
                <Minus size={18} aria-hidden />
              </IconButton>
              <span className="tnum w-14 text-center text-fg" aria-live="polite">
                {m.settings.px(fontSize)}
              </span>
              <IconButton
                label={m.settings.bigger}
                className="border border-control"
                disabled={fontSize >= MOBILE_FONT_MAX}
                onClick={() => void setAppearance({ fontSize: fontSize + 1 })}
              >
                <Plus size={18} aria-hidden />
              </IconButton>
            </div>
          </div>

          <SectionTitle>{m.settings.about}</SectionTitle>
          <div className="px-4 text-[14px] text-muted">
            <p>{m.settings.version(__APP_VERSION__)}</p>
            {agentVersion && <p className="mt-1">{m.settings.agent(agentVersion)}</p>}
          </div>
        </div>
      </main>
    </div>
  );
}
