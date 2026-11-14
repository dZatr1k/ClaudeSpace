import { CheckCircle2, Info, LoaderCircle, Plus, TriangleAlert, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import * as A from '../../actions';
import { agent } from '../../bridge';
import { t } from '../../i18n/ru';
import { matches, shortPath } from '../../lib/format';
import { useData } from '../../stores/data';
import type { Dialog, Toast } from '../../stores/ui';
import { useUi } from '../../stores/ui';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';

const close = () => useUi.getState().set({ dialog: null });
const inputCls =
  'h-8 w-full rounded-[4px] border border-control bg-base px-2.5 text-[13px] outline-none focus:border-accent focus:outline focus:outline-1 focus:outline-accent';

function Confirm({ d }: { d: Extract<Dialog, { kind: 'confirm' }> }) {
  return (
    <Modal
      open
      onClose={close}
      title={d.title}
      width={460}
      footer={
        <>
          <Button onClick={close}>{t.actions.cancel}</Button>
          <Button
            variant="danger"
            autoFocus
            onClick={() => {
              close();
              d.onConfirm();
            }}
          >
            {d.confirm}
          </Button>
        </>
      }
    >
      {d.danger && (
        <div className="mb-2 flex items-center gap-2 font-semibold text-st-error">
          <TriangleAlert size={15} aria-hidden />
          {d.danger}
        </div>
      )}
      {d.body && <div className="text-[13px] leading-relaxed text-muted">{d.body}</div>}
    </Modal>
  );
}

function Prompt({ d }: { d: Extract<Dialog, { kind: 'prompt' }> }) {
  const [v, setV] = useState(d.value);
  const submit = () => {
    close();
    d.onSubmit(v);
  };
  return (
    <Modal
      open
      onClose={close}
      title={d.title}
      width={460}
      footer={
        <>
          <Button onClick={close}>{t.actions.cancel}</Button>
          <Button variant="primary" onClick={submit}>
            {d.confirm}
          </Button>
        </>
      }
    >
      <input
        autoFocus
        className={inputCls}
        value={v}
        placeholder={d.placeholder}
        aria-label={typeof d.title === 'string' ? d.title : undefined}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {d.hint && <div className="mt-1.5 text-[12px] text-faint">{d.hint}</div>}
    </Modal>
  );
}

function NewChat() {
  const home = useData((d) => d.hello?.home ?? null);
  const [dirs, setDirs] = useState<string[] | null>(null);
  const [q, setQ] = useState('');
  const [other, setOther] = useState<string | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    agent('list_dirs').then(
      (r) => setDirs(r.dirs),
      () => setDirs(useData.getState().projects.map((p) => p.path)),
    );
  }, []);
  const list = useMemo(() => (dirs ?? []).filter((d) => matches(q, shortPath(d, home), d)), [dirs, q, home]);
  const pick = (d: string) => {
    close();
    void A.newChat(d);
  };
  const submitOther = async () => {
    if (!other) return;
    const path = other.startsWith('~/') && home ? home + other.slice(1) : other;
    try {
      await agent('project_preview', { path });
      pick(path);
    } catch {
      setMissing(path);
    }
  };
  return (
    <Modal open onClose={close} title={t.dialogs.newChatTitle} width={520}>
      {other === null ? (
        <>
          <input
            autoFocus
            className={inputCls}
            placeholder={t.sidebar.filter}
            aria-label={t.sidebar.filter}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setIdx((i) => Math.min(list.length, i + 1));
              if (e.key === 'ArrowUp') setIdx((i) => Math.max(0, i - 1));
              if (e.key === 'Enter') {
                if (idx < list.length) pick(list[idx] as string);
                else setOther((home ?? '~') + '/projects/');
              }
            }}
          />
          <div className="mt-2 max-h-[46vh] overflow-y-auto">
            {dirs === null && (
              <div className="flex items-center gap-2 p-2 text-[12px] text-muted" role="status">
                <LoaderCircle size={12} className="anim-spin" aria-hidden />
                {t.dialogs.loadingDirs}
              </div>
            )}
            {list.map((d, i) => (
              <button
                key={d}
                className={`mono flex h-8 w-full items-center rounded-[4px] px-2 text-left text-[12px] ${i === idx ? 'bg-selected text-fg' : 'hover:bg-hover'}`}
                onMouseEnter={() => setIdx(i)}
                onClick={() => pick(d)}
              >
                {shortPath(d, home)}
              </button>
            ))}
            <button
              className={`flex h-8 w-full items-center gap-2 rounded-[4px] px-2 text-left text-[13px] font-medium text-accent-text ${idx === list.length ? 'bg-selected' : 'hover:bg-hover'}`}
              onClick={() => setOther((home ?? '~') + '/projects/')}
            >
              <Plus size={14} aria-hidden />
              {t.dialogs.otherFolder}
            </button>
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <label htmlFor="cs-other-path" className="block text-[12px] text-muted">
            {t.dialogs.path}
          </label>
          <input
            id="cs-other-path"
            autoFocus
            className={`${inputCls} font-mono text-[12px]`}
            value={other}
            onChange={(e) => setOther(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submitOther()}
          />
          {missing && (
            <div className="flex items-center gap-2 text-[13px]">
              <span>{t.dialogs.folderMissing(shortPath(missing, home))}</span>
              <Button
                small
                variant="primary"
                onClick={async () => {
                  const p = await A.createProject(missing, false);
                  if (p) pick(p.path);
                }}
              >
                {t.actions.create}
              </Button>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={() => setOther(null)}>{t.actions.cancel}</Button>
            <Button variant="primary" onClick={() => void submitOther()}>
              {t.actions.newChat}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function CreateProject() {
  const home = useData((d) => d.hello?.home ?? '~');
  const [path, setPath] = useState(`${home}/projects/`);
  const [git, setGit] = useState(true);
  const submit = async () => {
    const p = await A.createProject(path, git);
    if (p) {
      close();
      useUi.getState().setSelection({ kind: 'project', path: p.path });
    }
  };
  return (
    <Modal
      open
      onClose={close}
      title={t.dialogs.createProject}
      footer={
        <>
          <Button onClick={close}>{t.actions.cancel}</Button>
          <Button variant="primary" onClick={() => void submit()}>
            {t.actions.create}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label htmlFor="cs-project-path" className="block text-[12px] text-muted">
          {t.dialogs.projectPath}
        </label>
        <input
          id="cs-project-path"
          autoFocus
          className={`${inputCls} font-mono text-[12px]`}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={git}
            onChange={(e) => setGit(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          {t.dialogs.gitInit}
        </label>
      </div>
    </Modal>
  );
}

function Clone() {
  const home = useData((d) => d.hello?.home ?? '~');
  const [url, setUrl] = useState('');
  const [dest, setDest] = useState(`${home}/projects/`);
  const [touched, setTouched] = useState(false);
  const onUrl = (u: string) => {
    setUrl(u);
    if (!touched) {
      const name =
        u
          .replace(/\/+$/, '')
          .split(/[/:]/)
          .pop()
          ?.replace(/\.git$/, '') ?? '';
      setDest(`${home}/projects/${name}`);
    }
  };
  const ok = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)\S+$/.test(url) && dest.length > 1;
  return (
    <Modal
      open
      onClose={close}
      title={t.dialogs.cloneTitle}
      footer={
        <>
          <Button onClick={close}>{t.actions.cancel}</Button>
          <Button
            variant="primary"
            disabled={!ok}
            onClick={() => {
              close();
              A.cloneRepo(url, dest);
            }}
          >
            {t.dialogs.cloneAction}
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-[13px]">
        <label htmlFor="cs-clone-url" className="block text-[12px] text-muted">
          {t.dialogs.cloneUrl}
        </label>
        <input
          id="cs-clone-url"
          autoFocus
          className={`${inputCls} font-mono text-[12px]`}
          value={url}
          placeholder="https://github.com/user/repo.git"
          onChange={(e) => onUrl(e.target.value)}
        />
        <label htmlFor="cs-clone-dest" className="block pt-1 text-[12px] text-muted">
          {t.dialogs.cloneDest}
        </label>
        <input
          id="cs-clone-dest"
          className={`${inputCls} font-mono text-[12px]`}
          value={dest}
          onChange={(e) => {
            setTouched(true);
            setDest(e.target.value);
          }}
        />
      </div>
    </Modal>
  );
}

function Paste({ d }: { d: Extract<Dialog, { kind: 'paste' }> }) {
  const lines = d.text.split(/\r\n|\r|\n/);
  return (
    <Modal
      open
      onClose={close}
      title={t.term.pasteTitle}
      width={560}
      footer={
        <>
          <Button onClick={close}>{t.actions.cancel}</Button>
          <Button
            variant="primary"
            autoFocus
            onClick={() => {
              close();
              d.onConfirm();
            }}
          >
            {t.actions.paste}
          </Button>
        </>
      }
    >
      <div className="mb-2 text-[13px]">{t.term.pasteBody(lines.length)}</div>
      <pre className="max-h-60 overflow-auto rounded-[6px] border border-line bg-base p-3 font-mono text-[12px] text-muted">
        {lines.slice(0, 30).join('\n')}
        {lines.length > 30 ? `\n… (+${lines.length - 30})` : ''}
      </pre>
    </Modal>
  );
}

export function Dialogs() {
  const d = useUi((u) => u.dialog);
  if (!d) return null;
  switch (d.kind) {
    case 'confirm':
      return <Confirm d={d} />;
    case 'prompt':
      return <Prompt d={d} />;
    case 'info':
      return (
        <Modal
          open
          onClose={close}
          title={d.title}
          width={460}
          footer={
            <Button variant="primary" autoFocus onClick={close}>
              {t.actions.ok}
            </Button>
          }
        >
          {d.body ?? null}
        </Modal>
      );
    case 'newChat':
      return <NewChat />;
    case 'createProject':
      return <CreateProject />;
    case 'clone':
      return <Clone />;
    case 'paste':
      return <Paste d={d} />;
  }
}

function ToastItem({ toast }: { toast: Toast }) {
  useEffect(() => {
    const id = setTimeout(() => useUi.getState().dismissToast(toast.id), toast.ttl);
    return () => clearTimeout(id);
  }, [toast.id, toast.ttl]);
  const Icon = toast.kind === 'error' ? TriangleAlert : toast.kind === 'success' ? CheckCircle2 : Info;
  const color =
    toast.kind === 'error' ? 'text-st-error' : toast.kind === 'success' ? 'text-st-idle' : 'text-st-busy';
  return (
    <div
      role={toast.kind === 'error' ? 'alert' : 'status'}
      className="anim-slide flex min-w-[300px] max-w-[440px] items-start gap-2.5 rounded-[10px] border border-line-strong bg-elevated py-2.5 pl-3 pr-2 text-[13px] leading-snug shadow-pop"
    >
      <Icon size={16} className={`mt-0.5 shrink-0 ${color}`} aria-hidden />
      <div className="min-w-0 flex-1 selectable">{toast.text}</div>
      {toast.action && (
        <button
          className="shrink-0 rounded-[4px] px-1 font-semibold text-accent-text hover:underline"
          onClick={() => {
            toast.action?.run();
            useUi.getState().dismissToast(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        aria-label={t.actions.close}
        className="shrink-0 rounded-[4px] p-0.5 text-muted hover:bg-hover hover:text-fg"
        onClick={() => useUi.getState().dismissToast(toast.id)}
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}

export function Toasts() {
  const toasts = useUi((u) => u.toasts);
  return (
    <div className="pointer-events-none fixed bottom-8 right-4 z-[60] flex flex-col items-end gap-2">
      {toasts.map((x) => (
        <div key={x.id} className="pointer-events-auto">
          <ToastItem toast={x} />
        </div>
      ))}
    </div>
  );
}
