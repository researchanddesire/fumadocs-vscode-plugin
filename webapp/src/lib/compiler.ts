import { createCompiler } from '@fumadocs/mdx-remote';

interface MdastNode {
  type: string;
}
interface MdastRoot {
  children: MdastNode[];
}

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  position?: { start?: { line?: number } };
  children?: HastNode[];
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

/** Shared runtime MDX compiler with the Fumadocs preset. */
export const compiler = createCompiler({
  remarkPlugins: (plugins) => [remarkStripEsm, ...plugins],
  rehypePlugins: (plugins) => [rehypeSourceLines, ...plugins],
  rehypeCodeOptions: {
    // Lazy-load Shiki languages so runtime compilation stays fast.
    lazy: true,
    themes: {
      light: 'github-light',
      dark: 'github-dark',
    },
  },
});
