// Files and Git panels (stage 5): which folder the panels show, and the actions they share (paste a path into the
// chat, copy it, download to the PC, upload from the PC).
import type { Selection } from '@shared/model';
import { FILE_UPLOAD_MAX } from '@shared/ipc';
import { invoke } from '../bridge';
import { getHandle } from '../components/Terminal/controller';
import { t } from '../i18n/ru';
import { useData } from '../stores/data';
import { activeTab } from '../stores/tabs';
import { useUi } from '../stores/ui';
import { basename, shortPath } from './format';

/** the folder of what the right panel describes: chat project, project, or the session's chat / cwd */
export function contextFolder(ctx: Selection): string | null {
  if (!ctx) return null;
  const d = useData.getState();
  if (ctx.kind === 'chat') return d.chats[ctx.id]?.project ?? null;
  if (ctx.kind === 'project') return ctx.path;
  const s = d.sessions.find((x) => x.name === ctx.name);
  const c = s?.claude[0];
  return (c && d.chats[c.chatId]?.project) || s?.path || null;
}

export const homeShort = (p: string) => shortPath(p, useData.getState().hello?.home ?? null);

const toast = (...a: Parameters<ReturnType<typeof useUi.getState>['toast']>) => useUi.getState().toast(...a);

/** type the path into the active terminal (Claude Code reads files by path) */
export function pastePathToChat(path: string): void {
  const tab = activeTab();
  const h = tab ? getHandle(tab.id) : undefined;
  if (!h) return toast(t.files.noTab, 'info');
  h.term.paste(path + ' ');
  h.term.focus();
}

export function copyPath(path: string): void {
  void invoke('clipboard.write', { text: path });
  toast(t.files.pathCopied, 'success', undefined, 2500);
}

export async function downloadFile(path: string): Promise<void> {
  const r = await invoke('file.download', { path });
  if (r.ok)
    toast(t.files.downloaded(basename(path)), 'success', {
      label: t.files.showInFolder,
      run: () => void invoke('file.reveal', { path: r.saved }),
    });
  else if ('error' in r) toast(t.files.downloadFailed(r.error), 'error');
}

async function uploadOne(dir: string, f: File, overwrite: boolean): Promise<boolean> {
  if (f.size > FILE_UPLOAD_MAX) {
    toast(t.files.tooBig(f.name), 'error');
    return false;
  }
  const slow = setTimeout(() => toast(t.files.uploading(f.name), 'info', undefined, 4000), 700);
  try {
    const r = await invoke('file.upload', {
      dir,
      name: f.name,
      data: new Uint8Array(await f.arrayBuffer()),
      overwrite,
    });
    if (r.ok) return true;
    if ('exists' in r) {
      toast(
        t.files.exists(f.name),
        'info',
        {
          label: t.files.replace,
          run: () =>
            void uploadOne(dir, f, true).then(
              (ok) => ok && toast(t.files.uploaded(f.name, homeShort(dir)), 'success'),
            ),
        },
        10000,
      );
      return false;
    }
    toast(t.files.uploadFailed(f.name, r.error), 'error');
    return false;
  } finally {
    clearTimeout(slow);
  }
}

/** upload PC files into a VM folder; existing names ask before replacing (toast with «Заменить») */
export async function uploadFiles(dir: string, files: File[]): Promise<number> {
  let ok = 0;
  for (const f of files) if (await uploadOne(dir, f, false)) ok++;
  if (ok === 1 && files.length === 1)
    toast(t.files.uploaded(files[0]?.name ?? '', homeShort(dir)), 'success');
  else if (ok > 0) toast(t.files.uploadedMany(ok, homeShort(dir)), 'success');
  return ok;
}

/** DataTransfer from the PC: only plain files (a dropped folder shows up as an entry with no type and size 0) */
export function droppedFiles(dt: DataTransfer): File[] {
  const items = Array.from(dt.items ?? []);
  const files: File[] = [];
  let folders = 0;
  items.forEach((it) => {
    const entry = (
      it as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory: boolean } | null }
    ).webkitGetAsEntry?.();
    if (entry?.isDirectory) folders++;
    else if (it.kind === 'file') {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  });
  if (!items.length) files.push(...Array.from(dt.files));
  if (folders) toast(t.files.folderSkipped, 'info');
  return files;
}
