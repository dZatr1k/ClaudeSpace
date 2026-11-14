// Images in Claude Code chats (Ctrl+V / drag and drop): main uploads them to the VM (src/main/images.ts) and the
// returned path is pasted into the terminal; Claude Code turns a pasted image path into an attachment.
import { invoke } from '../bridge';
import { getHandle } from '../components/Terminal/controller';
import { t } from '../i18n/ru';
import { useUi } from '../stores/ui';

const MAX = 20 * 1024 * 1024;
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;

export const isImageFile = (f: File) => IMAGE.test(f.type) || /\.(png|jpe?g|gif|webp)$/i.test(f.name);

function pastePaths(tabId: string, paths: string[]) {
  const h = getHandle(tabId);
  if (!h || !paths.length) return;
  h.term.paste(paths.join(' ') + ' ');
  h.term.focus();
}

/** slow uploads get a toast so the user knows something is happening */
async function withProgress<T>(p: Promise<T>): Promise<T> {
  const timer = setTimeout(() => useUi.getState().toast(t.images.uploading, 'info', undefined, 4000), 600);
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
  useUi.getState().toast(t.images.failed(r.error), 'error');
  return true;
}

export async function attachDroppedFiles(tabId: string, files: File[]): Promise<void> {
  const images = files.filter(isImageFile);
  if (images.length < files.length) useUi.getState().toast(t.images.notImage, 'info');
  const paths: string[] = [];
  for (const f of images) {
    if (f.size > MAX) {
      useUi.getState().toast(t.images.failed(t.images.tooBig(f.name)), 'error');
      continue;
    }
    const r = await withProgress(invoke('image.upload', { data: new Uint8Array(await f.arrayBuffer()) }));
    if (r.ok) paths.push(r.path);
    else useUi.getState().toast(t.images.failed(r.error), 'error');
  }
  pastePaths(tabId, paths);
}
