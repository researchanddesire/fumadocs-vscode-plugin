import { loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons';
import { getContentRoot } from './content-root';
import { scanContentRoot, type PageFileData } from './scan';

/**
 * Build a Fumadocs source from the current content root at request time.
 *
 * This intentionally avoids the build-time `fumadocs-mdx` pipeline so the app
 * can render *any* directory handed to it by the extension.
 */
export function buildSource() {
  const root = getContentRoot();
  const files = scanContentRoot(root);

  return loader({
    baseUrl: '/',
    source: { files },
    plugins: [lucideIconsPlugin()],
  });
}

export type PreviewSource = ReturnType<typeof buildSource>;
export type { PageFileData };
