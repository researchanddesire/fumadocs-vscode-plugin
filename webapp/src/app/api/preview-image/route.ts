import fs from 'node:fs';
import { contentTypeFor, isServableImage } from '@/lib/images';

export const dynamic = 'force-dynamic';

/**
 * Serve a local image referenced by a previewed Markdown/MDX file.
 *
 * The compiler rewrites relative and root-relative image `src`s to point here
 * (`/api/preview-image?p=<absolute path>`), since the previewed content lives
 * outside this app and is never part of its `public/` directory.
 * `isServableImage` guards against path traversal by requiring the file to be
 * a real image inside the previewed project.
 */
export function GET(request: Request): Response {
  const url = new URL(request.url);
  const p = url.searchParams.get('p');
  if (!p) return new Response('Missing image path', { status: 400 });
  if (!isServableImage(p)) return new Response('Image not found', { status: 404 });

  const data = fs.readFileSync(p);
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': contentTypeFor(p),
      // The same path can change on disk between edits; never cache.
      'Cache-Control': 'no-store',
    },
  });
}
