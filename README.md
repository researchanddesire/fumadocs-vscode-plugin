# fumadocs-vscode-plugin

**Fumadocs Helper** — a VSCode / Cursor extension that makes editing [Fumadocs](https://fumadocs.dev) MDX docs easy for everyone, even non-technical teammates.

It gives you a friendly way to add the "pretty" components (callouts, cards, tabs, steps, accordions, file trees, and more) without memorizing any syntax.

## What you get

- **Insert Component palette** — press `Cmd+Alt+I` (macOS) / `Ctrl+Alt+I` (Windows/Linux), or right-click → _Fumadocs: Insert Component_, pick a component from a plain-English list, and a ready-to-fill snippet is dropped in. Tab through the blanks; dropdowns appear for choices like a callout's type.
- **Type-ahead snippets** — start typing `callout`, `cards`, `tabs`, `steps`, `accordions`, `files`, `frontmatter`… and press Tab.
- **Autocomplete** — type `<` to see every component; inside a tag, get its available props with descriptions.
- **Hover help** — hover any component name to see what it does, its props, an example, and a link to the docs.
- **Mistake catching** — gentle warnings for missing frontmatter (`title` / `description`), unknown components that won't render, and invalid option values (e.g. a `Callout` `type` that isn't `info` / `warn` / `error` / `success`).

## Install (for the team)

1. Download the latest `fumadocs-vscode-plugin-x.y.z.vsix` (from a teammate or the repo Releases).
2. In Cursor / VSCode: open the **Extensions** panel → the `…` menu → **Install from VSIX…** → choose the file.
3. Open any `.mdx` file in `content/docs/` and start with `Cmd+Alt+I`.

That's it — no terminal required.

## Components it knows about

Callout, Cards, Card, Tabs, Tab, Steps, Step, Accordions, Accordion, Files, Folder, File, TypeTable, Banner, ImageZoom, InlineTOC.

The full list (with descriptions, props, and snippets) lives in [`src/components.json`](src/components.json). To add or tweak a component, edit that one file and rebuild — every feature (palette, autocomplete, hover, validation) updates automatically.

## Important: register the components in your Fumadocs app

Out of the box Fumadocs only renders `Card`, `Cards`, and `Callout`. The other components exist in `fumadocs-ui` but must be registered before they'll render. In your docs app, update `getMDXComponents` (e.g. `apps/docs-userguide/src/components/mdx.tsx`):

```tsx
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import { File, Folder, Files } from "fumadocs-ui/components/files";
import { TypeTable } from "fumadocs-ui/components/type-table";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Tabs,
    Tab,
    Steps,
    Step,
    Accordions,
    Accordion,
    Files,
    Folder,
    File,
    TypeTable,
    ...components,
  } satisfies MDXComponents;
}
```

Keep the component list in `src/components.json` in sync with what you register here, so "what you can insert" always matches "what actually renders".

## Develop

```bash
npm install
npm run watch      # rebuild on change
# then press F5 in VSCode to launch the Extension Development Host
```

Other scripts:

```bash
npm run build      # production bundle to dist/
npm run typecheck  # tsc --noEmit
npm run package    # produce a .vsix to share
```

## How it's built

A single manifest (`src/components.json`) is the source of truth. `src/manifest.ts` loads it, and the feature modules read from it:

- `src/commands.ts` — Insert Component palette + New Doc Page
- `src/completion.ts` — component name + prop autocomplete
- `src/hover.ts` — hover documentation
- `src/diagnostics.ts` — validation/warnings
- `src/extension.ts` — wires everything together on activation

## License

MIT
