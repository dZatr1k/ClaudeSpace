// Auto-update state (stage 7): main (updater.ts) -> renderer (Settings → О программе, update notice). Types only.

export type UpdateStatus =
  /** dev build or not a packaged Windows/Linux AppImage build: updates are off */
  | 'disabled'
  /** nothing checked yet */
  | 'idle'
  | 'checking'
  /** the latest release is the running version */
  | 'none'
  /** a newer version found, download starting */
  | 'available'
  | 'downloading'
  /** downloaded: installs on quit, or now via "restart and update" */
  | 'ready'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  /** running version */
  current: string;
  /** newer version found/downloaded */
  version: string | null;
  /** download progress 0..100 */
  percent: number | null;
  /** last finished check (ms), successful or not */
  lastCheck: number | null;
  error: string | null;
  /** why updates are off ('dev' | 'platform') */
  disabledReason: 'dev' | 'platform' | null;
}

export const initialUpdateState: UpdateState = {
  status: 'idle',
  current: '',
  version: null,
  percent: null,
  lastCheck: null,
  error: null,
  disabledReason: null,
};
