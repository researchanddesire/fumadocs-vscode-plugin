import { createCompiler } from '@fumadocs/mdx-remote';

interface MdastNode {
  type: string;
}
interface MdastRoot {
  children: MdastNode[];
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

/** Shared runtime MDX compiler with the Fumadocs preset. */
export const compiler = createCompiler({
  remarkPlugins: (plugins) => [remarkStripEsm, ...plugins],
  rehypeCodeOptions: {
    // Lazy-load Shiki languages so runtime compilation stays fast.
    lazy: true,
    themes: {
      light: 'github-light',
      dark: 'github-dark',
    },
  },
});
