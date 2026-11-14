// "Claude finished / needs input" notifications (BACKLOG #2): Windows notification, optional in-app toast, sound,
// brief flash of the tab/sidebar row.
// Source: `turn_done` events from the VM agent, which tails what the user's Claude Code hook (Stop / Notification,
// ~/.claude/hooks/notify.sh) writes. That is the exact end of every turn — no guessing from busy/idle statuses,
// so even a quick answer is reported. Which notifications to show is decided by notifyDecision (lib/notify.ts).
import type { TurnDone } from '@shared/protocol';
import { openSession } from './actions';
import { invoke, on } from './bridge';
import { t } from './i18n/ru';
import { playNotifySound } from './lib/chime';
import { notifyDecision } from './lib/notify';
import { useData } from './stores/data';
import { activeTab } from './stores/tabs';
import { useUi } from './stores/ui';

/** "MyGame": project folder as on the tab, else the tmux session name */
function labelOf(ev: TurnDone): string {
  const chatProject = ev.chatId ? useData.getState().chats[ev.chatId]?.project : null;
  const path = chatProject ?? ev.cwd;
  return (path && path.split('/').filter(Boolean).pop()) || ev.project || ev.session || 'Claude';
}

function flash(session: string) {
  const sel = `[data-tab="${CSS.escape(session)}"], [data-testid="session-${CSS.escape(session)}"]`;
  for (const el of document.querySelectorAll<HTMLElement>(sel)) {
    el.classList.remove('anim-flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('anim-flash');
    setTimeout(() => el.classList.remove('anim-flash'), 2600);
  }
}

const seen = new Set<string>();

function notify(ev: TurnDone) {
  const key = `${ev.chatId}:${ev.ts}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (seen.size > 200) seen.clear();

  const prefs = useUi.getState().settings?.notifications;
  if (!prefs) return;
  const tab = activeTab();
  const ctx = {
    focused: document.hasFocus() && document.visibilityState === 'visible',
    activeSession: tab?.kind === 'tmux' ? tab.session : null,
  };
  const kind = ev.kind === 'input' ? 'waiting' : 'idle';
  // a turn outside tmux has no session: never treat it as "the active tab"
  const d = notifyDecision(
    { session: ev.session ?? '\0', chatId: ev.chatId ?? '', kind, busyMs: 0 },
    prefs,
    ctx,
  );
  void invoke('diag.log', {
    text:
      `[notify] turn ${ev.kind} session=${ev.session ?? '-'} focused=${ctx.focused} ` +
      `active=${ctx.activeSession ?? '-'} onlyBackground=${prefs.onlyBackground} → ` +
      `windows=${d.system} toast=${d.toast} sound=${d.sound}`,
  });
  if (!d.toast && !d.sound && !d.system) return;

  const name = labelOf(ev);
  const title = ev.kind === 'input' ? t.notify.input(name) : t.notify.idle(name);
  const body = ev.body || (ev.kind === 'input' ? t.notify.inputBody : t.notify.systemBody);
  const open = () => {
    if (ev.session) openSession(ev.session, ev.chatId);
  };
  if (d.sound) void playNotifySound(prefs.volume, kind, prefs.soundFile);
  if (d.system)
    void invoke('notify.show', { title, body, session: ev.session ?? '', chatId: ev.chatId ?? undefined });
  if (d.toast)
    useUi
      .getState()
      .toast(
        `${title}. ${body}`,
        ev.kind === 'input' ? 'info' : 'success',
        ev.session ? { label: t.notify.open, run: open } : undefined,
        8000,
      );
  if (ev.session) flash(ev.session);
}

export function wireNotifications(): void {
  // click on a Windows notification: main has already focused the window
  on('notify.click', ({ session, chatId }) => {
    if (session) openSession(session, chatId ?? null); // '' = the test notification from Settings
  });
  on('agent.event', ({ event, data }) => {
    if (event === 'turn_done') notify(data as TurnDone);
  });
}
