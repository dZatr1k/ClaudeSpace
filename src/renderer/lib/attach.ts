// Files in Claude Code chats (Ctrl+V with an image, drag and drop, «Прикрепить» / Ctrl+Shift+A): main uploads them
// to the VM (src/main/attach.ts) and the returned path is pasted into the terminal. Claude Code turns an image path
// into an attachment; for other files the path stays text and Claude reads the file by it.
import { FILE_UPLOAD_MAX } from '@shared/ipc';
import { invoke } from '../bridge';
import { getHandle } from '../components/Terminal/controller';
import { t } from '../i18n/ru';
import { activeTab } from '../stores/tabs';
import { useUi } from '../stores/ui';

const toast = (...a: Parameters<ReturnType<typeof useUi.getState>['toast']>) => useUi.getState().toast(...a);

function pastePaths(tabId: string, paths: string[]) {
  const h = getHandle(tabId);
  if (!h || !paths.length) return;
  h.term.paste(paths.join(' ') + ' ');
  h.term.focus();
}

/** slow uploads get a toast so the user knows something is happening */
async function withProgress<T>(p: Promise<T>): Promise<T> {
  const timer = setTimeout(() => toast(t.attach.uploading, 'info', undefined, 4000), 600);
  try {
    return await p;
  } finally {
    clearTimeout(timer);
  }
}

/** Ctrl+V with an image in the clipboard; false = no image there (paste text as usual) */
export async function pasteClipboardImage(tabId: string): Promise<boolean> {
  const r = await withProgress(invoke('image.pasteClipboard'));
  if (r.ok) {
    pastePaths(tabId, [r.path]);
    return true;
  }
  if ('none' in r) return false;
  toast(t.attach.imageFailed(r.error), 'error');
  return true;
}

/** dropped or picked files of any type; their VM paths are pasted together, in the given order */
export async function attachFiles(tabId: string, files: File[]): Promise<void> {
  const paths: string[] = [];
  for (const f of files) {
    if (f.size > FILE_UPLOAD_MAX) {
      toast(t.attach.failed(f.name, t.attach.tooBig), 'error');
      continue;
    }
    const data = new Uint8Array(await f.arrayBuffer());
    const r = await withProgress(invoke('attach.upload', { name: f.name || 'file', data }));
    if (r.ok) paths.push(r.path);
    else toast(t.attach.failed(f.name, r.error), 'error');
  }
  pastePaths(tabId, paths);
}

/** the system file dialog (multiple files); [] when it was closed */
function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])), { once: true });
    input.addEventListener('cancel', () => resolve([]), { once: true });
    input.click();
  });
}

/** «Прикрепить» / Ctrl+Shift+A: pick files on the PC and attach them to the chat in the active tab */
export async function attachToActive(): Promise<void> {
  const tab = activeTab();
  if (!tab || !getHandle(tab.id) || tab.term !== 'live') {
    toast(t.attach.noTab, 'info');
    return;
  }
  const files = await pickFiles();
  if (files.length) await attachFiles(tab.id, files);
}
