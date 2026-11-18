// Files for Claude Code chats. Claude Code runs on the VM and sees only files there, so a pasted, dropped or picked
// file is uploaded over SFTP to ~/.cache/claudespace and its path is typed into the terminal. An image path turns
// into an attachment in Claude Code (the same as a file dragged into a local terminal); any other path stays text,
// and Claude reads the file when the prompt asks for it.
import { createHash } from 'node:crypto';
import { FILE_UPLOAD_MAX } from '../shared/ipc';
import type { Transport } from './transport/types';
import { execCollect, shq } from './transport/types';

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** the same limit as the Files panel: the bytes travel through IPC in memory */
export const ATTACH_MAX_BYTES = FILE_UPLOAD_MAX;
/** uploads older than this are removed on the next upload */
const KEEP_DAYS = 7;

/** image type by magic bytes (never by file name); null = not an image Claude Code reads */
export function imageExt(b: Uint8Array): 'png' | 'jpg' | 'gif' | 'webp' | null {
  const at = (i: number, ...v: number[]) => v.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'gif'; // GIF8
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp'; // RIFF....WEBP
  return null;
}

/**
 * The file name as it lands on the VM. The path is pasted into the prompt unquoted, so only letters (any script),
 * digits, «.», «_» and «-» stay; runs of anything else become one «_». The extension is kept: Claude goes by it.
 */
export function attachName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').normalize('NFC');
  const dot = base.lastIndexOf('.');
  const rawStem = dot > 0 ? base.slice(0, dot) : base;
  const rawExt = dot > 0 ? base.slice(dot + 1) : '';
  const stem = Array.from(
    rawStem
      .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^[._-]+|[._-]+$/g, ''),
  )
    .slice(0, 80)
    .join('');
  const ext = Array.from(rawExt.replace(/[^\p{L}\p{M}\p{N}]+/gu, ''))
    .slice(0, 12)
    .join('');
  return (stem || 'file') + (ext ? `.${ext}` : '');
}

export type UploadResult = { ok: true; path: string } | { ok: false; error: string };

const sha16 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex').slice(0, 16);

/**
 * Put data at ~/.cache/claudespace/<dir>/<rel>. Files are named by their content (sha-256), so the same file sent
 * twice, in one prompt or a day later, is one file on the VM: it is uploaded once and its date is refreshed so the
 * weekly cleanup keeps it.
 */
async function putInCache(
  t: Transport,
  dir: 'images' | 'files',
  rel: string,
  data: Uint8Array,
): Promise<UploadResult> {
  const r = await execCollect(
    t,
    `d="$HOME/.cache/claudespace/${dir}"; mkdir -p "$d" && chmod 700 "$d" && ` +
      `find "$d" -type f -mtime +${KEEP_DAYS} -delete 2>/dev/null; ` +
      `find "$d" -mindepth 1 -type d -empty -delete 2>/dev/null; ` +
      `f="$d"/${shq(rel)}; mkdir -p "$(dirname "$f")" && ` +
      `if [ -f "$f" ] && touch "$f"; then printf 'have\\n'; else printf 'new\\n'; fi; printf %s "$d"`,
  );
  const [state, base = ''] = r.stdout.split('\n');
  if (r.code !== 0 || !base.startsWith('/'))
    return { ok: false, error: r.stderr.trim() || 'Не удалось создать папку' };
  const path = `${base}/${rel}`;
  if (state !== 'have') await t.writeFile(path, Buffer.from(data), 0o600);
  return { ok: true, path };
}

/** a clipboard image (Ctrl+V): images only */
export async function uploadImage(t: Transport | null, data: Uint8Array): Promise<UploadResult> {
  if (!t) return { ok: false, error: 'Нет связи с VM' };
  if (data.length > IMAGE_MAX_BYTES)
    return { ok: false, error: `Картинка больше ${IMAGE_MAX_BYTES / 1024 / 1024} МБ` };
  const ext = imageExt(data);
  if (!ext) return { ok: false, error: 'Это не PNG, JPEG, GIF или WebP' };
  return putInCache(t, 'images', `img-${sha16(data)}.${ext}`, data);
}

/**
 * A dropped or picked file of any type. Images (by magic bytes) go to images/ as before, so Claude Code attaches
 * them; anything else goes to files/<sha16>/<name>, keeping a readable name for Claude.
 */
export async function uploadAttachment(
  t: Transport | null,
  name: string,
  data: Uint8Array,
): Promise<UploadResult> {
  if (!t) return { ok: false, error: 'Нет связи с VM' };
  if (imageExt(data)) return uploadImage(t, data);
  if (data.length > ATTACH_MAX_BYTES)
    return { ok: false, error: `Файл больше ${ATTACH_MAX_BYTES / 1024 / 1024} МБ` };
  return putInCache(t, 'files', `${sha16(data)}/${attachName(name)}`, data);
}
