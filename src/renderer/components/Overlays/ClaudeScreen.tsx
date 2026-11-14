// The «Claude» screen: what shapes Claude Code on the VM. Instructions (CLAUDE.md) and memory notes are edited here;
// MCP servers, skills, plugins and hooks are shown read-only with the command that changes them. The agent builds the
// overview (MCP keys never leave it) and writes only CLAUDE.md and memory notes, refusing if the file changed since it
// was loaded (cclib/claudecfg.py).
import { RotateCw, Save } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClaudeConfig, ClaudeDoc, ClaudeMemoryFile } from '@shared/protocol';
import { openVsCode } from '../../actions';
import { agent, invoke } from '../../bridge';
import { t } from '../../i18n/ru';
import { formatAgo, formatBytes } from '../../lib/format';
import { contextFolder, homeShort } from '../../lib/files';
import type { ClaudeSection } from '../../stores/ui';
import { useUi } from '../../stores/ui';
import { currentContext } from '../RightPanel/RightPanel';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { FileBody } from './FileViewer';

const T = () => t.claudeScreen;

export function openClaudeScreen(section: ClaudeSection = 'instructions'): void {
  const ui = useUi.getState();
  ui.set({ claudeScreen: { section, folder: contextFolder(currentContext(ui.selection)) } });
}

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; data: ClaudeConfig };

// ---------------------------------------------------------------- editor
type Doc = { path: string; exists: boolean };

/** Plain-text editor for one CLAUDE.md or memory note. Ctrl+S saves; a file changed on the VM meanwhile is a
 * conflict: nothing is written, the user's text goes to the clipboard before reloading. */
function DocEditor({
  doc,
  onDirty,
  onSaved,
}: {
  doc: Doc;
  onDirty: (d: boolean) => void;
  onSaved: () => void;
}) {
  const [st, setSt] = useState<
    | { state: 'loading' }
    | { state: 'error'; message: string }
    | { state: 'tooBig' }
    | { state: 'ok'; base: string; mtime: number | null }
  >({ state: 'loading' });
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ conflict: boolean; message: string } | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    setSt({ state: 'loading' });
    setProblem(null);
    if (!doc.exists) {
      setText('');
      setSt({ state: 'ok', base: '', mtime: null });
      return;
    }
    try {
      const f = await agent('fs_read', { path: doc.path });
      if (f.kind !== 'text' || f.truncated) return setSt({ state: 'tooBig' });
      setText(f.text);
      setSt({ state: 'ok', base: f.text, mtime: f.mtime });
    } catch (e) {
      setSt({ state: 'error', message: (e as Error).message });
    }
  }, [doc.path, doc.exists]);
  useEffect(() => void load(), [load]);

  const dirty = st.state === 'ok' && text !== st.base;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const save = async () => {
    if (st.state !== 'ok' || !dirty || saving) return;
    setSaving(true);
    setProblem(null);
    try {
      const r = await agent('claude_doc_write', { path: doc.path, text, mtime: st.mtime });
      setSt({ state: 'ok', base: text, mtime: r.mtime });
      setSavedAt(Date.now());
      onSaved();
    } catch (e) {
      const err = e as Error & { code?: string };
      setProblem({ conflict: err.code === 'conflict', message: err.message });
    } finally {
      setSaving(false);
    }
  };

  const reload = async () => {
    await invoke('clipboard.write', { text });
    useUi.getState().toast(T().copiedMine, 'info', undefined, 6000);
    await load();
  };

  if (st.state === 'loading') return <p className="p-4 text-[13px] text-muted">{t.info.loading}</p>;
  if (st.state === 'error')
    return (
      <p className="p-4 text-[13px] text-st-error" role="alert">
        {t.files.loadFailed(st.message)}
      </p>
    );
  if (st.state === 'tooBig')
    return (
      <div className="space-y-3 p-4 text-[13px] text-muted">
        <p>{T().tooBig}</p>
        <Button small onClick={() => openVsCode(doc.path)}>
          {t.files.vscode}
        </Button>
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 pb-2 text-[12px] text-muted">
        <span className="mono min-w-0 flex-1 truncate selectable" title={doc.path}>
          {homeShort(doc.path)}
        </span>
        <span aria-live="polite" className={dirty ? 'text-st-waiting' : ''}>
          {dirty ? T().unsaved : !doc.exists && st.mtime === null ? T().newFile : savedAt ? T().saved : ''}
        </span>
      </div>
      <textarea
        ref={area}
        className="mono selectable min-h-0 flex-1 resize-none rounded-[6px] border border-control bg-base p-3 text-[12.5px] leading-[19px] outline-none focus:border-accent"
        value={text}
        spellCheck={false}
        aria-label={T().editorLabel(homeShort(doc.path))}
        placeholder={doc.exists ? '' : T().newPlaceholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            void save();
          }
        }}
      />
      {problem && (
        <div className="mt-2 flex items-center gap-3 text-[12px] text-st-error" role="alert">
          <span className="min-w-0 flex-1">{problem.conflict ? T().conflict : problem.message}</span>
          {problem.conflict && (
            <Button small onClick={() => void reload()}>
              <RotateCw size={13} aria-hidden /> {T().reload}
            </Button>
          )}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-2 pt-3">
        <Button
          small
          variant="ghost"
          disabled={!dirty || saving}
          onClick={() => st.state === 'ok' && setText(st.base)}
        >
          {T().revert}
        </Button>
        <span className="flex-1" />
        <Button small onClick={() => openVsCode(doc.path)}>
          {t.files.vscode}
        </Button>
        <Button small variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
          <Save size={13} aria-hidden /> {saving ? T().saving : T().save}
          <span className="mono text-[11px] font-normal opacity-70">Ctrl+S</span>
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- lists
function Item({
  active,
  onClick,
  title,
  sub,
  dim,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  sub?: string | null;
  dim?: boolean;
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'true' : undefined}
      className={`block w-full rounded-[6px] px-2.5 py-1.5 text-left transition-colors duration-100 hover:bg-hover active:bg-selected ${active ? 'bg-selected' : ''}`}
      onClick={onClick}
    >
      <span
        className={`block truncate text-[13px] ${active ? 'font-semibold' : ''} ${dim ? 'text-muted' : ''}`}
      >
        {title}
      </span>
      {sub && <span className="block truncate text-[12px] text-faint">{sub}</span>}
    </button>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-1 mt-3 px-2.5 text-[12px] font-semibold text-muted first:mt-0">{children}</h3>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="mt-4 text-[12px] leading-relaxed text-faint">{children}</p>;
}

function Badge({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'off' | 'on' }) {
  const cls =
    tone === 'on'
      ? 'text-st-idle border-st-idle/40'
      : tone === 'off'
        ? 'text-faint border-line'
        : 'text-muted border-line-strong';
  return (
    <span className={`shrink-0 rounded-[4px] border px-1.5 text-[11px] leading-[18px] ${cls}`}>
      {children}
    </span>
  );
}

const scopeLabel = (s: string) => (T().scopes as Record<string, string>)[s] ?? s;

function docTitle(d: ClaudeDoc): string {
  const name = d.path.split('/').pop() ?? d.path;
  return d.scope === 'user' ? T().userDoc : `${scopeLabel(d.scope)}: ${name}`;
}

function SplitView({ list, detail }: { list: React.ReactNode; detail: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="w-60 shrink-0 overflow-auto border-r border-line pr-3">{list}</div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">{detail}</div>
    </div>
  );
}

function Instructions({
  cfg,
  onDirty,
  reload,
}: {
  cfg: ClaudeConfig;
  onDirty: (d: boolean) => void;
  reload: () => void;
}) {
  const [sel, setSel] = useState(0);
  const d = cfg.instructions[Math.min(sel, cfg.instructions.length - 1)];
  return (
    <SplitView
      list={
        <>
          {cfg.instructions.map((x, i) => (
            <Item
              key={x.path}
              active={x === d}
              onClick={() => setSel(i)}
              title={docTitle(x)}
              sub={x.exists ? `${homeShort(x.path)} · ${formatBytes(x.size)}` : T().missing}
              dim={!x.exists}
            />
          ))}
          <Hint>{cfg.folder ? T().instructionsHint(homeShort(cfg.folder)) : T().instructionsNoFolder}</Hint>
        </>
      }
      detail={d && <DocEditor key={d.path} doc={d} onDirty={onDirty} onSaved={reload} />}
    />
  );
}

function Memory({ cfg, onDirty }: { cfg: ClaudeConfig; onDirty: (d: boolean) => void }) {
  const all = cfg.memory.flatMap((g) => g.files);
  const [path, setPath] = useState<string | null>(all[0]?.path ?? null);
  const f: ClaudeMemoryFile | undefined = all.find((x) => x.path === path);
  if (!all.length) return <p className="text-[13px] text-muted">{T().noMemory}</p>;
  return (
    <SplitView
      list={cfg.memory.map((g) => (
        <section key={g.dir}>
          <Heading>
            {g.label}
            {g.current ? ` · ${T().current}` : ''}
          </Heading>
          {g.files.map((x) => (
            <Item
              key={x.path}
              active={x.path === path}
              onClick={() => setPath(x.path)}
              title={x.title || x.name}
              sub={x.description || (x.name === 'MEMORY.md' ? T().memoryIndex : formatAgo(x.mtime))}
            />
          ))}
        </section>
      ))}
      detail={
        f && (
          <DocEditor
            key={f.path}
            doc={{ path: f.path, exists: true }}
            onDirty={onDirty}
            onSaved={() => undefined}
          />
        )
      }
    />
  );
}

function Skills({ cfg }: { cfg: ClaudeConfig }) {
  const [path, setPath] = useState<string | null>(cfg.skills[0]?.path ?? null);
  if (!cfg.skills.length) return <p className="text-[13px] text-muted">{T().noSkills}</p>;
  const groups = new Map<string, typeof cfg.skills>();
  for (const s of cfg.skills) {
    const k = s.scope === 'plugin' ? T().fromPlugin(s.plugin ?? '') : scopeLabel(s.scope);
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  return (
    <SplitView
      list={
        <>
          {[...groups].map(([k, list]) => (
            <section key={k}>
              <Heading>{k}</Heading>
              {list.map((s) => (
                <Item
                  key={s.path}
                  active={s.path === path}
                  onClick={() => setPath(s.path)}
                  title={s.name}
                  sub={s.description}
                />
              ))}
            </section>
          ))}
          <Hint>{T().skillsHint}</Hint>
        </>
      }
      detail={path && <FileBody key={path} path={path} />}
    />
  );
}

function Mcp({ cfg }: { cfg: ClaudeConfig }) {
  return (
    <div>
      {cfg.mcp.length === 0 ? (
        <p className="text-[13px] text-muted">{T().noMcp}</p>
      ) : (
        <ul className="divide-y divide-line">
          {cfg.mcp.map((m) => (
            <li key={`${m.scope}:${m.name}`} className="flex items-center gap-3 py-2 text-[13px]">
              <span className="w-48 shrink-0 truncate font-medium selectable">{m.name}</span>
              <Badge>{scopeLabel(m.scope)}</Badge>
              <Badge tone="off">{m.type}</Badge>
              <span
                className="mono min-w-0 flex-1 truncate text-[12px] text-muted selectable"
                title={m.target}
              >
                {m.target}
              </span>
              {m.env > 0 && <span className="shrink-0 text-[12px] text-faint">{T().envCount(m.env)}</span>}
            </li>
          ))}
        </ul>
      )}
      <Hint>{T().mcpHint}</Hint>
    </div>
  );
}

function Plugins({ cfg }: { cfg: ClaudeConfig }) {
  return (
    <div>
      {cfg.plugins.length === 0 ? (
        <p className="text-[13px] text-muted">{T().noPlugins}</p>
      ) : (
        <ul className="divide-y divide-line">
          {cfg.plugins.map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-2 text-[13px]">
              <span className={`w-48 shrink-0 truncate font-medium ${p.enabled ? '' : 'text-muted'}`}>
                {p.name}
              </span>
              <Badge tone={p.enabled ? 'on' : 'off'}>{p.enabled ? T().on : T().off}</Badge>
              <span className="mono text-[12px] text-muted">{p.version}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-faint">{p.marketplace}</span>
            </li>
          ))}
        </ul>
      )}
      <Hint>{T().pluginsHint}</Hint>
    </div>
  );
}

function Hooks({ cfg }: { cfg: ClaudeConfig }) {
  const events = [...new Set(cfg.hooks.map((h) => h.event))];
  return (
    <div>
      {events.length === 0 && <p className="text-[13px] text-muted">{T().noHooks}</p>}
      {events.map((ev) => (
        <section key={ev} className="mb-4">
          <h3 className="mono mb-1 text-[12px] font-semibold text-muted">{ev}</h3>
          <ul className="divide-y divide-line rounded-[6px] border border-line">
            {cfg.hooks
              .filter((h) => h.event === ev)
              .map((h, i) => (
                <li key={i} className="flex items-center gap-3 px-3 py-2 text-[12px]">
                  <span className="mono min-w-0 flex-1 truncate selectable" title={h.command}>
                    {h.command}
                  </span>
                  {h.matcher && <Badge tone="off">{h.matcher}</Badge>}
                  {h.async && <Badge tone="off">{T().async}</Badge>}
                  {h.timeout !== null && (
                    <span className="tnum shrink-0 text-faint">{T().timeout(h.timeout)}</span>
                  )}
                  <Badge>{h.scope === 'plugin' ? T().fromPlugin(h.plugin ?? '') : scopeLabel(h.scope)}</Badge>
                </li>
              ))}
          </ul>
        </section>
      ))}
      <Hint>{T().hooksHint}</Hint>
    </div>
  );
}

// ---------------------------------------------------------------- screen
export function ClaudeScreen() {
  const open = useUi((u) => u.claudeScreen);
  const [st, setSt] = useState<Load>({ state: 'loading' });
  const dirtyRef = useRef(false);
  const onDirty = useCallback((d: boolean) => {
    dirtyRef.current = d;
  }, []);
  const folder = open?.folder ?? null;

  const load = useCallback(async () => {
    try {
      const data = await agent('claude_config', folder ? { path: folder } : {});
      setSt({ state: 'ok', data });
    } catch (e) {
      setSt({ state: 'error', message: (e as Error).message });
    }
  }, [folder]);
  useEffect(() => {
    if (!open) return;
    setSt({ state: 'loading' });
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!open, folder]);

  if (!open) return null;
  const ui = useUi.getState();
  const guard = (then: () => void) => {
    if (!dirtyRef.current) return then();
    ui.set({
      dialog: {
        kind: 'confirm',
        title: T().discardTitle,
        body: T().discardBody,
        confirm: T().discard,
        onConfirm: () => {
          dirtyRef.current = false;
          then();
        },
      },
    });
  };
  const go = (section: ClaudeSection) => guard(() => ui.set({ claudeScreen: { section, folder } }));
  const cfg = st.state === 'ok' ? st.data : null;
  const count = (s: ClaudeSection): number | null => {
    if (!cfg) return null;
    if (s === 'instructions') return cfg.instructions.filter((d) => d.exists).length;
    if (s === 'memory') return cfg.memory.reduce((n, g) => n + g.files.length, 0);
    return cfg[s].length;
  };
  const nav: ClaudeSection[] = ['instructions', 'memory', 'mcp', 'skills', 'plugins', 'hooks'];

  return (
    <Modal
      open
      onClose={() => guard(() => ui.set({ claudeScreen: null }))}
      title={folder ? T().titleIn(homeShort(folder)) : T().title}
      width={1040}
    >
      <div className="flex h-[62vh] min-h-[420px] gap-5" data-claude-screen={open.section}>
        <nav className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-line pr-3" aria-label={T().title}>
          {nav.map((id) => (
            <button
              key={id}
              type="button"
              aria-current={open.section === id ? 'page' : undefined}
              className={`flex h-8 items-center rounded-[6px] px-2.5 text-left text-[13px] transition-colors duration-100 ${open.section === id ? 'bg-selected font-semibold' : 'text-muted hover:bg-hover hover:text-fg'}`}
              onClick={() => go(id)}
            >
              <span className="flex-1">{T().nav[id]}</span>
              {count(id) !== null && (
                <span className="tnum text-[12px] font-normal text-faint">{count(id)}</span>
              )}
            </button>
          ))}
          <span className="flex-1" />
          <button
            type="button"
            className="flex h-8 items-center gap-2 rounded-[6px] px-2.5 text-[12px] text-muted hover:bg-hover hover:text-fg"
            onClick={() => guard(() => void load())}
          >
            <RotateCw size={13} aria-hidden /> {T().refresh}
          </button>
        </nav>
        <div className="min-h-0 min-w-0 flex-1">
          {st.state === 'loading' && <p className="text-[13px] text-muted">{t.info.loading}</p>}
          {st.state === 'error' && (
            <p className="text-[13px] text-st-error" role="alert">
              {t.files.loadFailed(st.message)}
            </p>
          )}
          {cfg && open.section === 'instructions' && (
            <Instructions cfg={cfg} onDirty={onDirty} reload={() => void load()} />
          )}
          {cfg && open.section === 'memory' && <Memory cfg={cfg} onDirty={onDirty} />}
          {cfg && open.section === 'skills' && <Skills cfg={cfg} />}
          {cfg && open.section === 'mcp' && <Mcp cfg={cfg} />}
          {cfg && open.section === 'plugins' && <Plugins cfg={cfg} />}
          {cfg && open.section === 'hooks' && <Hooks cfg={cfg} />}
        </div>
      </div>
    </Modal>
  );
}
