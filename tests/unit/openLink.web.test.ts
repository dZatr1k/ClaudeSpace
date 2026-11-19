// Links clicked in a chat: xterm (web-links) and Claude Code (BROWSER=openurl.py -> agent event open_url) both pass
// the same click on. The page must open once, localhost links still go through a port forward, and an event with
// anything but an http(s) URL is ignored.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const handlers: Array<(d: { event: string; data: unknown }) => void> = [];
(globalThis as unknown as { window: unknown }).window = {
  cs: {
    invoke: (...a: unknown[]) => invoke(...a),
    on: (name: string, cb: (d: { event: string; data: unknown }) => void) => {
      if (name === 'agent.event') handlers.push(cb);
      return () => undefined;
    },
    platform: 'linux',
  },
};

const { REPEAT_MS, openLink, openedRecently, wireOpenUrl } = await import('../../src/renderer/lib/ports');
wireOpenUrl();

const URL1 = 'https://example.com/jobs/7539589e';
const emit = (event: string, data: unknown) => handlers.forEach((h) => h({ event, data }));
const opened = () => invoke.mock.calls.filter((c) => c[0] === 'launch.openExternal').map((c) => c[1].url);

describe('openedRecently', () => {
  it('the same link within REPEAT_MS counts once; later it opens again', () => {
    const seen = new Map<string, number>();
    expect(openedRecently(URL1, 1000, seen)).toBe(false);
    expect(openedRecently(URL1, 1000 + REPEAT_MS - 1, seen)).toBe(true);
    expect(openedRecently('https://example.com/other', 1500, seen)).toBe(false);
    expect(openedRecently(URL1, 1000 + REPEAT_MS, seen)).toBe(false);
  });
});

describe('open_url from the VM', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ ok: true, vmPort: 5173, localPort: 5173, url: 'http://localhost:5173/' });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-19T10:00:00Z'));
  });

  it('a click seen by xterm and by Claude Code opens one tab', async () => {
    await openLink(URL1); // xterm web-links
    emit('open_url', { url: URL1 }); // Claude Code through BROWSER, a moment later
    await vi.advanceTimersByTimeAsync(10);
    expect(opened()).toEqual([URL1]);
    vi.setSystemTime(Date.now() + REPEAT_MS);
    emit('open_url', { url: URL1 }); // clicked again later: opens again
    await vi.advanceTimersByTimeAsync(10);
    expect(opened()).toEqual([URL1, URL1]);
  });

  it('a link only Claude Code knows (text without the address) opens from the event', async () => {
    emit('open_url', { url: 'https://example.com/only-from-claude' });
    await vi.advanceTimersByTimeAsync(10);
    expect(opened()).toEqual(['https://example.com/only-from-claude']);
  });

  it('localhost goes through a port forward, like a click in the terminal', async () => {
    emit('open_url', { url: 'http://localhost:5173/app' });
    await vi.advanceTimersByTimeAsync(10);
    expect(invoke).toHaveBeenCalledWith('ports.open', { url: 'http://localhost:5173/app' });
    expect(opened()).toEqual([]);
  });

  it('other events and non-web URLs are ignored', async () => {
    emit('open_url', { url: 'file:///etc/passwd' });
    emit('open_url', { url: 42 });
    emit('open_url', null);
    emit('ports_changed', { url: URL1 });
    await vi.advanceTimersByTimeAsync(10);
    expect(invoke).not.toHaveBeenCalled();
  });
});
