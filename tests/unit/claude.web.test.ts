// Quick actions for the active tab's Claude: which ones are allowed in which state, /clear asks first, errors toast.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeProc, Session, Tab } from '@shared/model';

const invoke = vi.fn();
(globalThis as unknown as { window: unknown }).window = {
  cs: { invoke: (...a: unknown[]) => invoke(...a), on: () => () => undefined, platform: 'linux' },
};

const { activeClaude, claudeAction, setModel } = await import('../../src/renderer/lib/claude');
const { useConn } = await import('../../src/renderer/stores/conn');
const { useData } = await import('../../src/renderer/stores/data');
const { useTabs } = await import('../../src/renderer/stores/tabs');
const { useUi } = await import('../../src/renderer/stores/ui');

const CHAT = '11111111-1111-4111-8111-111111111111';
const proc = (status: string): ClaudeProc => ({
  chatId: CHAT,
  status,
  pid: 1,
  window: '1',
  pane: '%3',
  name: null,
  statusAt: 0,
});
const session = (status: string): Session => ({
  name: 'alpha',
  attached: 1,
  activity: 0,
  windows: 1,
  path: '/home/u/projects/alpha',
  command: 'claude',
  claude: [proc(status)],
});
const tab: Tab = {
  id: 't1',
  kind: 'tmux',
  session: 'alpha',
  chatId: CHAT,
  cwd: '/home/u/projects/alpha',
  title: 'alpha',
  term: 'live',
};

function state(status: string) {
  useData.setState({ sessions: [session(status)] });
}
const sent = () => invoke.mock.calls.filter((c) => c[0] === 'agent.call').map((c) => c[1]);

describe('Claude quick actions', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ ok: true, result: { pane: '%3', status: 'idle' } });
    useConn.setState({ state: { kind: 'online' } as never });
    useTabs.setState({ tabs: [tab], activeId: 't1' });
    useUi.setState({ toasts: [], dialog: null });
  });

  it('finds the Claude of the active tmux tab only', () => {
    state('idle');
    expect(activeClaude()?.chatId).toBe(CHAT);
    useTabs.setState({ tabs: [{ ...tab, kind: 'shell' }] });
    expect(activeClaude()).toBeNull();
    useTabs.setState({ tabs: [tab] });
    useConn.setState({ state: { kind: 'offline' } as never });
    expect(activeClaude()).toBeNull();
  });

  it('idle: compact and model are sent, clear asks first', () => {
    state('idle');
    claudeAction('compact');
    setModel('sonnet');
    expect(sent()).toEqual([
      { method: 'claude_send', params: { chatId: CHAT, action: 'compact' } },
      { method: 'claude_send', params: { chatId: CHAT, action: 'model', model: 'sonnet' } },
    ]);
    claudeAction('clear');
    expect(sent()).toHaveLength(2);
    const d = useUi.getState().dialog;
    expect(d?.kind).toBe('confirm');
    if (d?.kind === 'confirm') d.onConfirm();
    expect(sent()[2]).toEqual({ method: 'claude_send', params: { chatId: CHAT, action: 'clear' } });
  });

  it('busy or asking for permission: only interrupt goes through', () => {
    for (const st of ['busy', 'waiting']) {
      invoke.mockClear();
      state(st);
      claudeAction('compact');
      claudeAction('clear');
      setModel('opus');
      expect(sent()).toEqual([]);
      claudeAction('interrupt');
      expect(sent()).toEqual([{ method: 'claude_send', params: { chatId: CHAT, action: 'interrupt' } }]);
    }
    expect(useUi.getState().dialog).toBeNull();
  });

  it('an agent error becomes a toast', async () => {
    state('idle');
    invoke.mockResolvedValue({ ok: false, error: { code: 'busy', message: 'Claude сейчас занят' } });
    claudeAction('compact');
    await new Promise((r) => setTimeout(r, 0));
    expect(useUi.getState().toasts.at(-1)?.text).toContain('Claude сейчас занят');
  });
});
