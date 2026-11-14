// BACKLOG 11: sudo prompt queue in the renderer — one modal at a time, dedupe, removal on done/answer/disconnect,
// and the password never lands in any store.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskpassRequest } from '@shared/askpass';
import { askpassReplySchema } from '@shared/askpass';

const invoke = vi.fn();
(globalThis as unknown as { window: unknown }).window = {
  cs: { invoke: (...a: unknown[]) => invoke(...a), on: () => () => undefined, platform: 'linux' },
};

const { answerAskpass, onAskpassEvent } = await import('../../src/renderer/askpass');
const { dequeue, enqueue, MAX_QUEUE, useAskpass } = await import('../../src/renderer/stores/askpass');
const { useUi } = await import('../../src/renderer/stores/ui');

const req = (id: string, extra: Partial<AskpassRequest> = {}): AskpassRequest => ({
  id,
  prompt: '[sudo] password:',
  command: 'sudo apt update',
  cwd: '/home/u',
  session: 'alpha',
  at: 1,
  ...extra,
});
const ID1 = '0123456789abcdef';
const ID2 = 'fedcba9876543210';

describe('askpass queue', () => {
  beforeEach(() => {
    useAskpass.getState().clear();
    useUi.setState({ toasts: [] });
    invoke.mockReset();
  });

  it('enqueue dedupes and caps, dequeue removes', () => {
    let q = enqueue([], req(ID1));
    expect(enqueue(q, req(ID1))).toBe(q);
    q = enqueue(q, req(ID2));
    expect(q.map((x) => x.id)).toEqual([ID1, ID2]);
    expect(dequeue(q, 'nope')).toBe(q);
    expect(dequeue(q, ID1).map((x) => x.id)).toEqual([ID2]);
    let big: AskpassRequest[] = [];
    for (let i = 0; i < MAX_QUEUE + 3; i++) big = enqueue(big, req(i.toString(16).padStart(16, '0')));
    expect(big).toHaveLength(MAX_QUEUE);
  });

  it('agent events: request queues (first one shown), done removes, timeout toasts', () => {
    onAskpassEvent('askpass_request', req(ID1));
    onAskpassEvent('askpass_request', req(ID2));
    onAskpassEvent('askpass_request', req(ID1));
    expect(useAskpass.getState().queue.map((x) => x.id)).toEqual([ID1, ID2]);
    onAskpassEvent('askpass_done', { id: ID1, reason: 'timeout' });
    expect(useAskpass.getState().queue.map((x) => x.id)).toEqual([ID2]);
    expect(useUi.getState().toasts).toHaveLength(1);
    onAskpassEvent('askpass_done', { id: ID1, reason: 'timeout' }); // already gone: no second toast
    onAskpassEvent('askpass_done', { id: ID2, reason: 'gone' });
    expect(useAskpass.getState().queue).toEqual([]);
    expect(useUi.getState().toasts).toHaveLength(1);
    onAskpassEvent('turn_done', req(ID1)); // other events are ignored
    expect(useAskpass.getState().queue).toEqual([]);
  });

  it('answer: removed at once, password only goes to IPC, never into a store', async () => {
    invoke.mockResolvedValue({ ok: true });
    onAskpassEvent('askpass_request', req(ID1));
    onAskpassEvent('askpass_request', req(ID2));
    const p = answerAskpass(ID1, 'hunter2');
    expect(useAskpass.getState().queue.map((x) => x.id)).toEqual([ID2]);
    await p;
    expect(invoke).toHaveBeenCalledWith('askpass.reply', { id: ID1, password: 'hunter2' });
    expect(JSON.stringify(useAskpass.getState())).not.toContain('hunter2');
    expect(JSON.stringify(useUi.getState().toasts)).not.toContain('hunter2');
    await answerAskpass(ID2, null);
    expect(invoke).toHaveBeenLastCalledWith('askpass.reply', { id: ID2, password: null });
    expect(useAskpass.getState().queue).toEqual([]);
  });

  it('failed delivery shows an error without the password', async () => {
    invoke.mockResolvedValue({ ok: false, error: 'запрос пароля уже закрыт' });
    onAskpassEvent('askpass_request', req(ID1));
    await answerAskpass(ID1, 'hunter2');
    const toasts = useUi.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.kind).toBe('error');
    expect(toasts[0]?.text).not.toContain('hunter2');
  });

  it('reply schema: id format, length cap, no newlines', () => {
    expect(askpassReplySchema.safeParse({ id: ID1, password: 'x' }).success).toBe(true);
    expect(askpassReplySchema.safeParse({ id: ID1, password: null }).success).toBe(true);
    expect(askpassReplySchema.safeParse({ id: ID1, password: '' }).success).toBe(true);
    expect(askpassReplySchema.safeParse({ id: 'zz', password: 'x' }).success).toBe(false);
    expect(askpassReplySchema.safeParse({ id: ID1, password: 'a\nb' }).success).toBe(false);
    expect(askpassReplySchema.safeParse({ id: ID1, password: 'x'.repeat(1025) }).success).toBe(false);
    expect(askpassReplySchema.safeParse({ id: ID1, password: 'x', extra: 1 }).success).toBe(false);
  });
});
