import fs from 'node:fs';
import path from 'node:path';

/**
 * Basename of the git repository that owns `startDir`.
 *
 * Walks from `startDir` toward the filesystem root and returns the directory
 * name of the nearest ancestor (or `startDir` itself) that contains a `.git`
 * entry (directory or worktree file).
 */
export function getGitRepoName(startDir: string): string | null {
  let cursor = path.resolve(startDir);

  for (;;) {
    if (hasGitEntry(cursor)) {
      return path.basename(cursor);
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return null;
}

function hasGitEntry(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}
