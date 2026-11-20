// «Журнал подключения»: the core's recent log lines (connection steps, the agent's messages, what the Android service
// did), to read or copy when something does not work. Kept in memory by the core, nothing is written to disk.
import { ChevronLeft, Copy, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { invoke } from '../bridge';
import { m } from '../strings';
import { back } from '../store';
import { Button, IconButton, copy } from '../ui';

export function Log() {
  const [lines, setLines] = useState<string[] | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const load = () => {
    invoke('log.get').then(setLines, () => setLines([]));
  };
  useEffect(load, []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [lines]);
  return (
    <div className="safe flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-line bg-surface pr-1">
        <IconButton label={m.chat.back} onClick={back}>
          <ChevronLeft size={24} strokeWidth={1.75} aria-hidden />
        </IconButton>
        <h1 className="flex-1 text-[16px] font-semibold">{m.settings.journalTitle}</h1>
        <IconButton label={m.settings.journalRefresh} onClick={load}>
          <RefreshCw size={20} strokeWidth={1.75} aria-hidden />
        </IconButton>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-3 py-2" data-testid="journal">
        {lines?.length === 0 && <p className="px-1 py-3 text-[15px] text-muted">{m.settings.journalEmpty}</p>}
        {lines?.map((l, i) => (
          <p
            key={i}
            className="mono select-text whitespace-pre-wrap break-all py-0.5 leading-snug text-muted"
          >
            {l}
          </p>
        ))}
        <div ref={end} />
      </main>
      <div className="shrink-0 border-t border-line bg-surface px-4 py-3">
        <Button
          className="w-full"
          disabled={!lines?.length}
          onClick={() => void copy((lines ?? []).join('\n'))}
        >
          <Copy size={16} aria-hidden /> {m.settings.journalCopy}
        </Button>
      </div>
    </div>
  );
}
