import * as fs from "fs";
import * as path from "path";

/**
 * Resolve the nearest "content root" for a given file.
 *
 * Strategy (in order):
 *  1. The outermost ancestor directory whose name is one of `contentDirNames`
 *     (so `.../content/docs/x.mdx` resolves to `.../content`).
 *  2. The nearest ancestor that *contains* a content-named subdirectory
 *     (so a file at a project root resolves to its `content/` folder).
 *  3. The file's own directory (lets you preview a loose folder of markdown).
 */
export function findContentRoot(
  filePath: string,
  contentDirNames: string[] = ["content"],
): string {
  const names = new Set(contentDirNames.map((n) => n.toLowerCase()));
  const startDir = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()
    ? filePath
    : path.dirname(filePath);

  // 1. Highest ancestor named like a content dir (closest to the fs root).
  let cursor = startDir;
  let highestMatch: string | null = null;
  for (;;) {
    if (names.has(path.basename(cursor).toLowerCase())) {
      highestMatch = cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (highestMatch) return highestMatch;

  // 2. Nearest ancestor that contains a content-named subdirectory.
  cursor = startDir;
  for (;;) {
    for (const name of contentDirNames) {
      const candidate = path.join(cursor, name);
      if (isDir(candidate)) return candidate;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  // 3. Fall back to the file's directory.
  return startDir;
}

/**
 * Like {@link findContentRoot} but returns `null` when only the step-3
 * directory fallback would apply (no named content root in the path).
 */
export function findNamedContentRoot(
  filePath: string,
  contentDirNames: string[] = ["content"],
): string | null {
  const names = new Set(contentDirNames.map((n) => n.toLowerCase()));
  const startDir = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()
    ? filePath
    : path.dirname(filePath);

  let cursor = startDir;
  let highestMatch: string | null = null;
  for (;;) {
    if (names.has(path.basename(cursor).toLowerCase())) {
      highestMatch = cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (highestMatch) return highestMatch;

  cursor = startDir;
  for (;;) {
    for (const name of contentDirNames) {
      const candidate = path.join(cursor, name);
      if (isDir(candidate)) return candidate;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return null;
}

/**
 * Map a file to the URL path the preview app serves it at, relative to root.
 * `content/index.mdx` -> `/`, `content/test/page.mdx` -> `/test/page`.
 */
export function computeSlugPath(root: string, filePath: string): string {
  const rel = path.relative(root, filePath);
  const ext = path.extname(rel);
  let withoutExt = rel.slice(0, rel.length - ext.length);
  const segments = withoutExt.split(path.sep).filter(Boolean);
  if (segments.length > 0 && segments[segments.length - 1] === "index") {
    segments.pop();
  }
  return "/" + segments.join("/");
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
