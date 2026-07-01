import { createCompiler } from '@fumadocs/mdx-remote';
import { imageUrl, resolveLocalImage } from './images';

interface MdastNode {
  type: string;
}
interface MdastRoot {
  children: MdastNode[];
}

interface MdxJsxAttribute {
  type: string;
  name?: string;
  value?: unknown;
}

interface HastNode {
  type: string;
  tagName?: string;
  /** Component name for `mdxJsxFlowElement` / `mdxJsxTextElement` nodes. */
  name?: string;
  properties?: Record<string, unknown>;
  /** Attributes for MDX JSX element nodes (e.g. authored `<img src="…">`). */
  attributes?: MdxJsxAttribute[];
  position?: { start?: { line?: number } };
  children?: HastNode[];
}

interface VFileLike {
  path?: string;
}

/**
 * Remove top-level ESM `import` / `export` statements.
 *
 * `@fumadocs/mdx-remote` has no bundler, so import/export in MDX can't be
 * resolved. We strip them and instead inject every common Fumadocs component
 * globally (see `components/mdx.tsx`), so authored files that `import` those
 * components still render.
 */
function remarkStripEsm() {
  return (tree: MdastRoot) => {
    tree.children = tree.children.filter((node) => node.type !== 'mdxjsEsm');
  };
}

/**
 * Stamp every rendered element with `data-source-line`, the 1-based line in
 * the MDX source where it begins. The webview's scroll-sync uses these to map
 * the editor's cursor line to the nearest element in the preview.
 */
function rehypeSourceLines() {
  const visit = (node: HastNode): void => {
    const line = node.position?.start?.line;
    if (node.type === 'element' && typeof line === 'number') {
      node.properties = node.properties ?? {};
      node.properties['data-source-line'] = String(line);
    }
    if (node.children) {
      for (const child of node.children) visit(child);
    }
  };
  return (tree: HastNode) => visit(tree);
}

/**
 * Rewrite local image `src`s so they resolve against the previewed file rather
 * than the preview page URL.
 *
 * The previewed content lives in an arbitrary directory outside this app, so a
 * relative `./img.png` or root-relative `/img/x.png` would otherwise be
 * resolved by the browser against the current route and 404. We rewrite both
 * to `/__fd-image?p=<absolute path>`, which the image route streams from disk.
 *
 * Handles markdown images (`![](…)` → hast `img` elements) and authored JSX
 * (`<img src="…">` → `mdxJsx*Element` nodes). External URLs are left untouched.
 */
function rewriteImageSrc(src: string, sourceFile: string): string | null {
  const abs = resolveLocalImage(src, sourceFile);
  return abs ? imageUrl(abs) : null;
}

/** Rewrite a markdown image (`![](…)` → hast `img` element). */
function rewriteHastImg(node: HastNode, sourceFile: string): void {
  const props = node.properties ?? {};
  if (typeof props.src !== 'string') return;
  const next = rewriteImageSrc(props.src, sourceFile);
  if (next) {
    props.src = next;
    node.properties = props;
  }
}

/** Rewrite an authored JSX image (`<img src="…">` → `mdxJsx*Element`). */
function rewriteJsxImg(node: HastNode, sourceFile: string): void {
  if (!Array.isArray(node.attributes)) return;
  for (const attr of node.attributes) {
    if (
      attr?.type === 'mdxJsxAttribute' &&
      attr.name === 'src' &&
      typeof attr.value === 'string'
    ) {
      const next = rewriteImageSrc(attr.value, sourceFile);
      if (next) attr.value = next;
    }
  }
}

function rewriteImageNode(node: HastNode, sourceFile: string): void {
  if (node.type === 'element' && node.tagName === 'img') {
    rewriteHastImg(node, sourceFile);
    return;
  }
  const isJsx =
    node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement';
  if (isJsx && node.name === 'img') rewriteJsxImg(node, sourceFile);
}

function rehypeResolveImages() {
  return (tree: HastNode, file: VFileLike) => {
    const sourceFile = typeof file?.path === 'string' ? file.path : undefined;
    if (!sourceFile) return;
    const visit = (node: HastNode): void => {
      rewriteImageNode(node, sourceFile);
      if (node.children) {
        for (const child of node.children) visit(child);
      }
    };
    visit(tree);
  };
}

/** Shared runtime MDX compiler with the Fumadocs preset. */
export const compiler = createCompiler({
  // Enable Fumadocs' remark-image so markdown images get width/height like
  // production (Next.js Image Optimization). Kept preview-safe: `external:false`
  // avoids remote size fetches (offline/404), `onError:'ignore'` skips sizing
  // for paths it can't resolve here. `rehypeResolveImages` still owns src
  // rewriting to the preview-image route.
  remarkImageOptions: { external: false, onError: "ignore" },
  remarkPlugins: (plugins) => [remarkStripEsm, ...plugins],
  rehypePlugins: (plugins) => [
    rehypeSourceLines,
    rehypeResolveImages,
    ...plugins,
  ],
  rehypeCodeOptions: {
    // Lazy-load Shiki languages so runtime compilation stays fast.
    lazy: true,
    themes: {
      light: 'github-light',
      dark: 'github-dark',
    },
  },
});
