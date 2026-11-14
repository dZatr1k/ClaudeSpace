// Files panel transfers (stage 5). The agent validates every path first (home only, deny-list: fs_upload_target /
// fs_download_source); only then the bytes travel over SFTP. Nothing here accepts a path the agent has not checked.
import { basename, join } from 'node:path';
import type { Transport } from './transport/types';

interface Deps {
  transport: () => Transport | null;
  call: <T>(method: string, params: unknown, timeoutMs: number) => Promise<T>;
  /** save dialog: the chosen local path, or null when cancelled */
  askSavePath: (suggested: string) => Promise<string | null>;
  downloadsDir: () => string;
  log: (...a: unknown[]) => void;
}

export type DownloadResult =
  { ok: true; saved: string } | { ok: false; cancelled: true } | { ok: false; error: string };
export type UploadResult =
  { ok: true; path: string } | { ok: false; exists: true } | { ok: false; error: string };

export class FileTransfers {
  /** local files this app saved: the only ones file.reveal may show */
  private readonly saved = new Set<string>();

  constructor(private readonly d: Deps) {}

  async download(remote: string): Promise<DownloadResult> {
    const t = this.d.transport();
    if (!t) return { ok: false, error: 'Нет связи с VM' };
    try {
      const src = await this.d.call<{ path: string; size: number }>(
        'fs_download_source',
        { path: remote },
        10_000,
      );
      const local = await this.d.askSavePath(join(this.d.downloadsDir(), basename(src.path)));
      if (!local) return { ok: false, cancelled: true };
      await t.download(src.path, local);
      this.saved.add(local);
      this.d.log('[files] downloaded', src.size, 'B', src.path, '->', local);
      return { ok: true, saved: local };
    } catch (e) {
      this.d.log('[files] download failed:', (e as Error).message);
      return { ok: false, error: (e as Error).message };
    }
  }

  async upload(dir: string, name: string, data: Uint8Array, overwrite = false): Promise<UploadResult> {
    const t = this.d.transport();
    if (!t) return { ok: false, error: 'Нет связи с VM' };
    try {
      const dst = await this.d.call<{ path: string; exists: boolean }>(
        'fs_upload_target',
        { dir, name },
        10_000,
      );
      if (dst.exists && !overwrite) return { ok: false, exists: true };
      await t.writeFile(dst.path, Buffer.from(data), 0o644);
      this.d.log('[files] uploaded', data.length, 'B ->', dst.path);
      return { ok: true, path: dst.path };
    } catch (e) {
      this.d.log('[files] upload failed:', (e as Error).message);
      return { ok: false, error: (e as Error).message };
    }
  }

  canReveal(local: string): boolean {
    return this.saved.has(local);
  }
}
