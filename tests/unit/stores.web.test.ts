import { describe, expect, it } from 'vitest';
import type { Chat, Session } from '../../src/shared/model';
import { applyEvent } from '../../src/renderer/stores/data';
import type { DataState } from '../../src/renderer/stores/data';
import { sessionStatus, sortSessions, claudeUi, isUnknownStatus } from '../../src/renderer/lib/status';

const chat = (id: string, extra: Partial<Chat> = {}): Chat => ({
  id,
  project: '/p',
  title: id,
  titleSource: 'ai',
  firstPrompt: null,
  prompts: 1,
  promptsApprox: false,
  branch: null,
  linesAdded: null,
  linesRemoved: null,
  firstAt: null,
  lastAt: 1,
  sizeBytes: 1,
  claudeVersion: null,
  archived: false,
  open: null,
  ...extra,
});
const base: DataState = {
  sessions: [],
  chats: {},
  projects: [],
  system: null,
  doctor: null,
  usage: null,
  hello: null,
  stale: true,
  staleAt: null,
  sessionsSynced: false,
  ports: [],
};

describe('data events', () => {
  it('chats: full, upsert, remove', () => {
    let st = { ...base, ...applyEvent(base, 'chats_changed', { full: [chat('a'), chat('b')] }) } as DataState;
    expect(Object.keys(st.chats)).toEqual(['a', 'b']);
    st = {
      ...st,
      ...applyEvent(st, 'chats_changed', { upsert: [chat('a', { title: 'A2' }), chat('c')], remove: ['b'] }),
    } as DataState;
    expect(Object.keys(st.chats).sort()).toEqual(['a', 'c']);
    expect(st.chats.a?.title).toBe('A2');
  });
  it('active_changed marks sessions synced and not stale; unknown events ignored', () => {
    const p = applyEvent(base, 'active_changed', { sessions: [] });
    expect(p).toMatchObject({ sessionsSynced: true, stale: false });
    expect(applyEvent(base, 'future_event', {})).toBeNull();
  });
});

const sess = (name: string, statuses: string[], activity = 0): Session => ({
  name,
  attached: 0,
  activity,
  windows: 1,
  path: '/p',
  command: statuses.length ? 'claude' : 'bash',
  claude: statuses.map((s, i) => ({
    chatId: `c${i}`,
    status: s,
    pid: i,
    window: '0',
    pane: `%${i}`,
    name: null,
    statusAt: 0,
  })),
});

describe('status mapping', () => {
  it('session status: waiting > busy > idle; none without Claude', () => {
    expect(sessionStatus(sess('a', ['idle', 'waiting'])).ui).toBe('waiting');
    expect(sessionStatus(sess('a', ['busy', 'idle'])).ui).toBe('busy');
    expect(sessionStatus(sess('a', [])).ui).toBe('none');
  });
  it('unknown status values are shown as idle and flagged', () => {
    expect(claudeUi('shell')).toBe('idle');
    expect(isUnknownStatus('shell')).toBe(true);
    expect(isUnknownStatus('busy')).toBe(false);
  });
  it('sort: waiting, busy, then by activity', () => {
    const list = sortSessions([
      sess('old', [], 1),
      sess('busy', ['busy'], 0),
      sess('new', [], 9),
      sess('wait', ['waiting'], 0),
    ]);
    expect(list.map((s) => s.name)).toEqual(['wait', 'busy', 'new', 'old']);
  });
});
