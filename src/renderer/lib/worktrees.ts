// Parallel tasks in git worktrees: create a branch in its own folder and start a Claude there; remove a finished
// one. The agent does the git work and the safety checks (cclib/worktrees.py).
import type { GitWorktree } from '@shared/protocol';
import * as A from '../actions';
import { agent } from '../bridge';
import { t } from '../i18n/ru';
import { useUi } from '../stores/ui';

export { branchFromName } from './branch';

const toast = (...a: Parameters<ReturnType<typeof useUi.getState>['toast']>) => useUi.getState().toast(...a);

/** window event: the Git panel reloads (a task was created outside it) */
export const GIT_CHANGED = 'cs-git-changed';

export function newTaskDialog(repo: string): void {
  useUi.getState().set({ dialog: { kind: 'newTask', repo } });
}

/** -> true when created (the dialog closes) */
export async function createTask(
  repo: string,
  branch: string,
  base: string | null,
  startClaude: boolean,
): Promise<boolean> {
  try {
    const r = await agent('worktree_create', { path: repo, branch, ...(base ? { base } : {}) });
    toast(r.created ? t.worktrees.created(r.branch) : t.worktrees.reopened(r.branch), 'success');
    window.dispatchEvent(new Event(GIT_CHANGED));
    if (startClaude) await A.newChat(r.path);
    return true;
  } catch (e) {
    toast(t.worktrees.createFailed((e as Error).message), 'error', undefined, 8000);
    return false;
  }
}

export function removeTask(repo: string, w: GitWorktree, done: () => void): void {
  const name = w.branch ?? w.path.split('/').pop() ?? w.path;
  const dirty = (w.dirty ?? 0) > 0;
  useUi.getState().set({
    dialog: {
      kind: 'confirm',
      title: t.worktrees.removeTitle(name),
      body: dirty ? t.worktrees.removeDirty(w.dirty ?? 0) : t.worktrees.removeBody,
      danger: dirty ? t.worktrees.removeDirtyDanger : undefined,
      confirm: t.worktrees.remove,
      onConfirm: () =>
        void (async () => {
          try {
            const r = await agent('worktree_remove', {
              path: repo,
              worktree: w.path,
              force: dirty,
              deleteBranch: true,
            });
            toast(
              r.branchDeleted
                ? t.worktrees.removedWithBranch(name)
                : t.worktrees.removed(name, r.branchKept ?? ''),
              'success',
              undefined,
              r.branchKept ? 8000 : undefined,
            );
          } catch (e) {
            toast(t.worktrees.removeFailed((e as Error).message), 'error', undefined, 8000);
          }
          done();
        })(),
    },
  });
}
