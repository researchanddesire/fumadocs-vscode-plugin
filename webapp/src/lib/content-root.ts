import fs from 'node:fs';
import path from 'node:path';

/**
 * The absolute directory whose Markdown/MDX files we render.
 *
 * A single dev server serves whichever root the VSCode extension points it at.
 * The active root is read fresh on every request, in priority order:
 *   1. `.preview-state.json` (written by the extension as you switch files)
 *   2. `FUMADOCS_CONTENT_ROOT` env var
 *   3. a bundled demo directory (standalone `next dev`)
 */
export function getContentRoot(): string {
  const fromState = readStateRoot();
  if (fromState) return path.resolve(fromState);

  const env = process.env.FUMADOCS_CONTENT_ROOT;
  if (env && env.trim().length > 0) return path.resolve(env);

  return path.join(process.cwd(), 'demo-content');
}

function readStateRoot(): string | null {
  try {
    const statePath = path.join(process.cwd(), '.preview-state.json');
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw) as { root?: unknown };
    if (typeof parsed.root === 'string' && parsed.root.trim().length > 0) {
      return parsed.root;
    }
  } catch {
    // No/invalid state file — fall through to env/demo.
  }
  return null;
}
