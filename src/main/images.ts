// Images for Claude Code chats: Claude Code runs on the VM and can only see files there, so a pasted or dropped
// image is uploaded over SFTP to ~/.cache/claudespace/images and its path is typed into the terminal (Claude Code
// attaches an image path pasted into its prompt, the same as a file dragged into a local terminal).
import { createHash } from 'node:crypto';
import type { Transport } from './transport/types';
import { execCollect } from './transport/types';

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** uploaded images older than this are removed on the next upload */
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

export type UploadResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * The file is named by its content (sha-256), so the same picture pasted twice, in one prompt or a day later, is one
 * file on the VM: it is uploaded once and its date is refreshed so the weekly cleanup keeps it.
 */
export async function uploadImage(t: Transport | null, data: Uint8Array): Promise<UploadResult> {
  if (!t) return { ok: false, error: 'Нет связи с VM' };
  if (data.length > IMAGE_MAX_BYTES)
    return { ok: false, error: `Картинка больше ${IMAGE_MAX_BYTES / 1024 / 1024} МБ` };
  const ext = imageExt(data);
  if (!ext) return { ok: false, error: 'Это не PNG, JPEG, GIF или WebP' };
  const name = `img-${createHash('sha256').update(data).digest('hex').slice(0, 16)}.${ext}`;
  const r = await execCollect(
    t,
    `d="$HOME/.cache/claudespace/images"; mkdir -p "$d" && chmod 700 "$d" && ` +
      `find "$d" -type f -mtime +${KEEP_DAYS} -delete 2>/dev/null; ` +
      `if [ -f "$d/${name}" ] && touch "$d/${name}"; then printf 'have\n'; else printf 'new\n'; fi; printf %s "$d"`,
  );
  const [state, dir = ''] = r.stdout.split('\n');
  if (r.code !== 0 || !dir.startsWith('/'))
    return { ok: false, error: r.stderr.trim() || 'Не удалось создать папку' };
  const path = `${dir}/${name}`;
  if (state !== 'have') await t.writeFile(path, Buffer.from(data), 0o600);
  return { ok: true, path };
}
