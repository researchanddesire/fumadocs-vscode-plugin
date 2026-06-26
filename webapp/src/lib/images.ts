import fs from 'node:fs';
import path from 'node:path';
import { getProjectRoot } from './content-root';

/** Preview-only route that streams local image files from disk. */
export const IMAGE_ROUTE = '/api/preview-image';

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.avif',
  '.ico',
  '.bmp',
  '.apng',
]);

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.apng': 'image/apng',
};

function isImagePath(p: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(p).toLowerCase());
}

/** MIME type for a file path, defaulting to a generic binary type. */
export function contentTypeFor(p: string): string {
  return CONTENT_TYPES[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * URLs we must not rewrite: anything with a scheme (`http:`, `https:`, `data:`,
 * `mailto:`…), protocol-relative URLs, and in-page anchors.
 */
export function isExternalSrc(src: string): boolean {
  return (
    src.length === 0 ||
    /^[a-z][a-z0-9+.-]*:/i.test(src) ||
    src.startsWith('//') ||
    src.startsWith('#')
  );
}

/**
 * Resolve an authored image `src` to an absolute path on disk, given the
 * absolute path of the MDX file it appears in:
 *
 *  - root-relative (`/img/foo.png`) → `<projectRoot>/public/img/foo.png`
 *  - relative (`./x.png`, `../x.png`, `x.png`) → relative to the MDX file's dir
 *
 * Returns null for external URLs (which are left untouched).
 */
export function resolveLocalImage(
  src: string,
  sourceFile: string,
): string | null {
  if (isExternalSrc(src)) return null;
  // Drop any query string / hash before touching the filesystem.
  const clean = src.split(/[?#]/, 1)[0];
  if (!clean) return null;

  let decoded = clean;
  try {
    decoded = decodeURI(clean);
  } catch {
    // Malformed escape sequence — fall back to the raw value.
  }

  if (decoded.startsWith('/')) {
    return path.join(getProjectRoot(), 'public', decoded);
  }
  return path.resolve(path.dirname(sourceFile), decoded);
}

/** Build the preview URL that serves `absPath` through the image route. */
export function imageUrl(absPath: string): string {
  return `${IMAGE_ROUTE}?p=${encodeURIComponent(absPath)}`;
}

/**
 * Whether a requested absolute path may be served: it must be a real image
 * file contained within the previewed project (no path-traversal escapes).
 */
export function isServableImage(absPath: string): boolean {
  if (!isImagePath(absPath)) return false;

  const resolved = path.resolve(absPath);
  const root = path.resolve(getProjectRoot());
  const rel = path.relative(root, resolved);
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (!inside) return false;

  try {
    return fs.statSync(resolved).isFile();
  } catch {
    return false;
  }
}
