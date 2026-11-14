// Full-text search through chat transcripts (stage 6): the agent scans the JSONL files on the VM and streams hits;
// ⏎ / click shows the chat in the «Чаты» list (preview on the right), Ctrl+⏎ continues it.
import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SearchHit, SearchMatch } from '@shared/protocol';
import * as A from '../../actions';
import { t } from '../../i18n/ru';
import { cancelSearch, MIN_QUERY, runSearch } from '../../lib/chatSearch';
import { formatAgo, shortPath } from '../../lib/format';
import { useConn } from '../../stores/conn';
import { useData } from '../../stores/data';
import { useSearch } from '../../stores/search';
import { useUi } from '../../stores/ui';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';

function Snippet({ m }: { m: SearchMatch }) {
  const [s, e] = m.match;
  return (
    <div className="truncate text-[12px] text-muted">
      <span className="mr-1 font-medium text-faint">{m.role === 'user' ? t.search.you : t.info.claude}:</span>
      {m.text.slice(0, s)}
      <mark className="rounded-[2px] bg-accent-soft px-0.5 text-fg">{m.text.slice(s, e)}</mark>
      {m.text.slice(e)}
    </div>
  );
}

function close() {
  cancelSearch();
  useUi.getState().set({ chatSearch: null });
}

function show(h: SearchHit) {
  close();
  A.showChatInList(h.chatId);
}

function cont(h: SearchHit) {
  const chat = useData.getState().chats[h.chatId];
  close();
  if (chat) void A.continueChat(chat);
  else A.showChatInList(h.chatId);
}

function statusLine(s: ReturnType<typeof useSearch.getState>): string {
  if (s.error) return s.error;
  if (s.query.trim().length < MIN_QUERY) return t.search.hint;
  if (s.running) return t.search.running(s.hits.length);
  const d = s.done;
  if (!d) return '';
  const parts = [t.search.found(d.found)];
  if (d.truncated) parts.push(t.search.truncated);
  if (d.timedOut) parts.push(t.search.timedOut(d.scanned, d.total));
  else parts.push(t.search.scanned(d.scanned, d.ms));
  return parts.join(' · ');
}

function Panel({ initial }: { initial: string }) {
  const [q, setQ] = useState(initial);
  const [sel, setSel] = useState(0);
  const st = useSearch();
  const online = useConn((c) => c.state.kind === 'online');
  const projects = useData((d) => d.projects);
  const home = useData((d) => d.hello?.home ?? null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => void runSearch(q), 300);
    return () => clearTimeout(timer);
  }, [q]);
  useEffect(() => setSel(0), [st.id]);
  useEffect(() => {
    list.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const pname = (p: string | null) =>
    p ? (projects.find((x) => x.path === p)?.name ?? shortPath(p, home)) : t.sidebar.noFolder;
  const cur = st.hits[sel];
  return (
    <div className="flex h-[60vh] flex-col">
      <div className="flex items-center gap-2 rounded-[6px] border border-control bg-base px-3 focus-within:border-accent focus-within:outline focus-within:outline-1 focus-within:outline-accent">
        <Search size={15} className="text-faint" aria-hidden />
        <input
          autoFocus
          data-testid="chat-search-input"
          aria-label={t.search.title}
          className="h-10 min-w-0 flex-1 bg-transparent text-[14px] outline-none"
          placeholder={t.search.placeholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((i) => Math.min(st.hits.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter' && cur) {
              e.preventDefault();
              if (e.ctrlKey) cont(cur);
              else show(cur);
            }
          }}
        />
      </div>
      <div className="mt-2 text-[12px] text-muted" role="status" data-testid="chat-search-status">
        {online ? statusLine(st) : t.search.offline}
      </div>
      <div ref={list} className="mt-2 min-h-0 flex-1 overflow-y-auto">
        {st.hits.map((h, i) => (
          <div
            key={h.chatId}
            data-idx={i}
            data-testid={`search-hit-${h.chatId}`}
            role="button"
            tabIndex={-1}
            className={`group rounded-[6px] px-3 py-2 ${i === sel ? 'bg-selected' : 'hover:bg-hover'}`}
            onMouseEnter={() => setSel(i)}
            onClick={() => show(h)}
            onDoubleClick={() => cont(h)}
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{h.title}</span>
              <span className="tnum shrink-0 text-[12px] text-muted">
                {pname(h.project)} · {formatAgo(h.lastAt)}
                {h.archived ? ` · ${t.search.archived}` : ''} · {t.search.matches(h.count)}
              </span>
              <Button
                small
                className={i === sel ? '' : 'invisible group-hover:visible'}
                onClick={(e) => {
                  e.stopPropagation();
                  cont(h);
                }}
              >
                {t.actions.continue}
              </Button>
            </div>
            {h.matches.map((m, j) => (
              <Snippet key={j} m={m} />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-3 border-t border-line pt-2 text-[12px] text-faint">{t.search.keys}</div>
    </div>
  );
}

export function ChatSearch() {
  const initial = useUi((u) => u.chatSearch);
  if (initial === null) return null;
  return (
    <Modal open onClose={close} title={t.search.title} width={760}>
      <Panel initial={initial} />
    </Modal>
  );
}
