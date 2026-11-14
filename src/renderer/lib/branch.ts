// Task name -> git branch name for a new worktree task (lib/worktrees.ts); pure, so tests import it alone.
/** task name -> branch name: lower case, spaces and odd characters become dashes */
export function branchFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-./]+|[-./]+$/g, '')
    .slice(0, 60);
}
