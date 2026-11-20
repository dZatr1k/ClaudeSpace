// Settings: the connection (saving reconnects), the phone key, the theme and the terminal font.
import { ChevronLeft, ChevronRight, Minus, Plus, ScrollText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MOBILE_FONT_MAX, MOBILE_FONT_MIN } from '@shared/mobile';
import type { MobileSettings, NotifyPermission } from '@shared/mobile';
import { useData } from '../../renderer/stores/data';
import { invoke } from '../bridge';
import { m } from '../strings';
import { back, go, useApp } from '../store';
import { Button, IconButton, KeyBlock, SectionTitle } from '../ui';
import { SetupForm } from './Connect';

const THEMES: MobileSettings['appearance']['theme'][] = ['system', 'dark', 'light'];

async function setAppearance(p: Partial<MobileSettings['appearance']>) {
  const s = await invoke('settings.set', { appearance: p });
  useApp.getState().set({ settings: s });
}

/** Background connection and Android's notification permission (asked when the switch goes on). */
function Background({ on }: { on: boolean }) {
  const [perm, setPerm] = useState<NotifyPermission | null>(null);
  useEffect(() => {
    void invoke('notify.permission', { request: false }).then(setPerm, () => setPerm(null));
  }, []);
  const ask = () => void invoke('notify.permission', { request: true }).then(setPerm);
  const toggle = async () => {
    const s = await invoke('settings.set', { notifications: { background: !on } });
    useApp.getState().set({ settings: s });
    if (s.notifications.background && perm === 'prompt') ask();
  };
  return (
    <div className="px-4">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => void toggle()}
        className="flex min-h-12 w-full items-center gap-3 text-left"
      >
        <span className="flex-1 text-[15px]">{m.settings.backgroundSwitch}</span>
        <span
          aria-hidden
          className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors duration-100 ${on ? 'border-accent bg-accent' : 'border-control bg-base'}`}
        >
          <span
            className={`absolute top-[3px] h-5 w-5 rounded-full transition-[left] duration-100 ${on ? 'left-[24px] bg-accent-fg' : 'left-[3px] bg-muted'}`}
          />
        </span>
      </button>
      <p className="text-[14px] leading-snug text-muted">
        {on ? m.settings.backgroundHint : m.settings.backgroundOff}
      </p>
      {perm && perm !== 'granted' && (
        <div className="mt-3 rounded-[6px] border border-st-waiting p-3">
          <p className="text-[14px] leading-snug">
            {perm === 'denied' ? m.settings.permissionDenied : m.settings.permissionPrompt}
          </p>
          {perm === 'prompt' ? (
            <Button className="mt-2 w-full" onClick={ask}>
              {m.settings.permissionAsk}
            </Button>
          ) : (
            <Button className="mt-2 w-full" onClick={() => void invoke('notify.openSettings')}>
              {m.settings.permissionSettings}
            </Button>
          )}
        </div>
      )}
    </div>
  );
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

          <SectionTitle>{m.settings.background}</SectionTitle>
          <Background on={settings.notifications.background} />

          <SectionTitle>{m.settings.about}</SectionTitle>
          <div className="px-4 text-[14px] text-muted">
            <p>{m.settings.version(__APP_VERSION__)}</p>
            {agentVersion && <p className="mt-1">{m.settings.agent(agentVersion)}</p>}
          </div>
          <button
            type="button"
            onClick={() => go({ kind: 'log' })}
            className="mt-3 flex min-h-12 w-full items-center gap-3 px-4 text-left active:bg-selected"
          >
            <ScrollText size={18} strokeWidth={1.75} className="shrink-0 text-faint" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-[15px]">{m.settings.journal}</span>
              <span className="block text-[13px] text-muted">{m.settings.journalHint}</span>
            </span>
            <ChevronRight size={18} className="text-faint" aria-hidden />
          </button>
        </div>
      </main>
    </div>
  );
}
