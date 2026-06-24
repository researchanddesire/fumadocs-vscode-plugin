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

## Releasing a new version

Releases are automated by GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml)). To cut a release:

1. Bump the `version` in [`package.json`](package.json) (e.g. `0.1.0` → `0.2.0`).
2. Commit and push to `main`.
3. Tag the commit with a matching `v` prefix and push the tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The workflow then verifies the tag matches `package.json`, typechecks, packages the `.vsix`, and publishes a **GitHub Release** with the `.vsix` attached (and release notes auto-generated). Teammates grab the `.vsix` from the [Releases page](https://github.com/researchanddesire/fumadocs-vscode-plugin/releases) and install it.

> The tag **must** match the package version (`v0.2.0` ↔ `"version": "0.2.0"`), or the release job fails on purpose to prevent mismatched builds.

Every push/PR to `main` also runs a [CI build](.github/workflows/ci.yml) that typechecks and smoke-tests packaging.

### Optional: publish to Open VSX

If the `OPEN_VSX_TOKEN` repo secret is set, the release workflow also publishes to the [Open VSX registry](https://open-vsx.org), so teammates can install it directly from Cursor's extension search (no manual VSIX). If the secret is absent, that step is skipped and the GitHub Release is still created.

One-time setup:

1. Sign in to [open-vsx.org](https://open-vsx.org) with GitHub.
2. Sign the publisher agreement: User Settings → "Eclipse Foundation Open VSX Publisher Agreement".
3. Create an access token: [open-vsx.org/user-settings/tokens](https://open-vsx.org/user-settings/tokens) → Generate New Token.
4. Create the `researchanddesire` namespace (must match `publisher` in `package.json`):
   ```bash
   npx ovsx create-namespace researchanddesire -p <token>
   ```
5. Add the token as a GitHub Actions secret named `OPEN_VSX_TOKEN`:
   Repo → Settings → Secrets and variables → Actions → New repository secret. (Or `gh secret set OPEN_VSX_TOKEN`.)

## How it's built

A single manifest (`src/components.json`) is the source of truth. `src/manifest.ts` loads it, and the feature modules read from it:

- `src/commands.ts` — Insert Component palette + New Doc Page
- `src/completion.ts` — component name + prop autocomplete
- `src/hover.ts` — hover documentation
- `src/diagnostics.ts` — validation/warnings
- `src/extension.ts` — wires everything together on activation

## License

MIT
