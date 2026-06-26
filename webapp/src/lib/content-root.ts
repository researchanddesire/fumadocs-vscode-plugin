import fs from 'node:fs';
import path from 'node:path';

/** Parsed shape of `.preview-state.json` written by the VSCode extension. */
interface PreviewState {
  /** Absolute content root, or null when unset. */
  root: string | null;
  /**
   * Live-edit overrides: absolute file path -> unsaved editor buffer content.
   * Lets the preview render in-editor changes before they're saved to disk.
   */
  overrides: Record<string, string>;
}

/**
 * Read `.preview-state.json` fresh on every call (the page is force-dynamic).
 * Tolerates a missing/invalid file by returning empty state.
 */
function readPreviewState(): PreviewState {
  try {
    const statePath = path.join(process.cwd(), '.preview-state.json');
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw) as { root?: unknown; overrides?: unknown };
    const root =
      typeof parsed.root === 'string' && parsed.root.trim().length > 0
        ? parsed.root
        : null;
    const overrides: Record<string, string> = {};
    if (parsed.overrides && typeof parsed.overrides === 'object') {
      for (const [key, value] of Object.entries(
        parsed.overrides as Record<string, unknown>,
      )) {
        if (typeof value === 'string') overrides[path.resolve(key)] = value;
      }
    }
    return { root, overrides };
  } catch {
    // No/invalid state file — fall through to env/demo with no overrides.
    return { root: null, overrides: {} };
  }
}

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
  const { root } = readPreviewState();
  if (root) return path.resolve(root);

  const env = process.env.FUMADOCS_CONTENT_ROOT;
  if (env && env.trim().length > 0) return path.resolve(env);

  return path.join(process.cwd(), 'demo-content');
}

/**
 * Live-edit overrides keyed by absolute path. Empty when there are no dirty
 * buffers (or when running standalone without the extension).
 */
export function getContentOverrides(): Record<string, string> {
  return readPreviewState().overrides;
}

/**
 * The project root for the active content root — i.e. the directory whose
 * `public/` folder backs root-relative image paths like `/img/foo.png`.
 *
 * The content root is usually a `content/` (or deeper) subdirectory, while
 * assets live in a sibling `public/`. Walk up from the content root to the
 * nearest ancestor that looks like a project root (`public/`, `.git`, or
 * `package.json`), falling back to the content root's parent.
 *
 * Also used as the containment boundary for the image route, so only files
 * inside the previewed project can be served.
 */
export function getProjectRoot(): string {
  const root = getContentRoot();
  let dir = root;
  for (;;) {
    if (
      isDir(path.join(dir, 'public')) ||
      isDir(path.join(dir, '.git')) ||
      fileExists(path.join(dir, 'package.json'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const parent = path.dirname(root);
  return parent === root ? root : parent;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
