// Strip under the terminal of a tab with Claude running: its status and the actions people otherwise type
// (Esc, /compact, /clear, /model). Commands are only enabled while Claude is idle (lib/claude.ts says why).
import { ChevronDown, Cpu, Eraser, FoldVertical, Paperclip, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CLAUDE_MODELS } from '@shared/protocol';
import { t } from '../../i18n/ru';
import { attachToActive } from '../../lib/attach';
import { canCommand, canInterrupt, claudeAction, setModel } from '../../lib/claude';
import { claudeUi, isUnknownStatus, primaryClaude, statusLine } from '../../lib/status';
import { useConn } from '../../stores/conn';
import { useData } from '../../stores/data';
import { activeTab, useTabs } from '../../stores/tabs';
import { DropdownMenu } from '../ui/Menu';
import { StatusIcon } from '../ui/StatusIcon';

const btn =
  'flex h-6 items-center gap-1.5 rounded-[5px] px-2 text-[12px] text-muted transition-colors duration-100 hover:bg-hover hover:text-fg active:bg-selected disabled:pointer-events-none disabled:opacity-40';

export function ClaudeBar() {
  useTabs((s) => s.activeId);
  useTabs((s) => s.tabs);
  const sessions = useData((d) => d.sessions);
  const online = useConn((c) => c.state.kind === 'online');
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 15_000); // «думает 2 мин» keeps counting
    return () => window.clearInterval(id);
  }, []);

  const tab = activeTab();
  if (!online || !tab || tab.kind !== 'tmux' || !tab.session || tab.term !== 'live') return null;
  const s = sessions.find((x) => x.name === tab.session);
  const c = s ? primaryClaude(s) : null;
  if (!c) return null;

  const idle = canCommand(c);
  const why = idle ? undefined : t.claudeBar.busy;
  return (
    <div
      className="flex h-8 shrink-0 items-center gap-1 border-t border-line bg-surface pl-3 pr-2"
      role="toolbar"
      aria-label={t.claudeBar.label}
      data-testid="claude-bar"
    >
      <StatusIcon status={claudeUi(c.status)} size={13} unknown={isUnknownStatus(c.status)} />
      <span className="tnum min-w-0 flex-1 truncate pl-1 text-[12px] text-muted" aria-live="polite">
        {statusLine(c.status, c.statusAt)}
      </span>
      <button type="button" className={btn} title={t.attach.buttonHint} onClick={() => void attachToActive()}>
        <Paperclip size={13} aria-hidden /> {t.attach.button}
      </button>
      {canInterrupt(c) && (
        <button
          type="button"
          className={`${btn} text-fg`}
          title={t.claudeBar.interruptHint}
          onClick={() => claudeAction('interrupt', c)}
        >
          <Square size={12} aria-hidden /> {t.claudeBar.interrupt}
        </button>
      )}
      <button
        type="button"
        className={btn}
        disabled={!idle}
        title={why ?? t.claudeBar.compactHint}
        onClick={() => claudeAction('compact', c)}
      >
        <FoldVertical size={13} aria-hidden /> {t.claudeBar.compact}
      </button>
      <button
        type="button"
        className={btn}
        disabled={!idle}
        title={why ?? t.claudeBar.clearHint}
        onClick={() => claudeAction('clear', c)}
      >
        <Eraser size={13} aria-hidden /> {t.claudeBar.clear}
      </button>
      <DropdownMenu
        align="end"
        items={CLAUDE_MODELS.map((m) => ({
          label: t.claudeBar.models[m] ?? m,
          hint: `/model ${m}`,
          disabled: !idle,
          run: () => setModel(m, c),
        }))}
        trigger={
          <button type="button" className={btn} disabled={!idle} title={why ?? t.claudeBar.modelHint}>
            <Cpu size={13} aria-hidden /> {t.claudeBar.model}
            <ChevronDown size={12} aria-hidden />
          </button>
        }
      />
    </div>
  );
}
