# Fumadocs Preview

**Open source and free.** A VS Code extension that live-previews any MDX or Markdown file — or an entire `content/` directory — with a real [Fumadocs](https://fumadocs.dev) site rendered side-by-side in the editor.

Useful when working with a non-technical team who just wants to quickly see what the layout and settings will roughly look like, without running a full docs project locally.

There is **no** custom renderer or WYSIWYG editor. The extension ships a real Next.js + Fumadocs app and serves your content through it, so what you see is what Fumadocs would render — just scoped to preview mode.

## Quick start

1. Open an `.mdx` or `.md` file.
2. Run **Fumadocs: Preview** (`Cmd+Alt+V` / `Ctrl+Alt+V`, the editor title-bar menu, or the CodeLens link at the top of the file).
3. The preview opens beside your editor. Save to reload; switch files to navigate.

On first run, the bundled renderer installs its dependencies from the committed lockfile (~1 minute once). Requires `node` and a package manager (`npm`, `pnpm`, or `yarn`) on your `PATH`.

## How it works

1. The extension finds the **nearest content root** for the active file — the closest ancestor directory named `content` by default (configurable).
2. It starts a single Fumadocs `next dev` server and points it at that root.
3. The preview webview loads the page for your file inside a real `DocsLayout` (sidebar, TOC, typography, components).
4. **Saving** any file under the active root hot-reloads the preview.
5. **Switching** to another MDX/MD file updates the preview. If the new file lives under a different content root, the server switches roots at runtime — no restart needed.

Because rendering uses Fumadocs' runtime MDX compiler ([`@fumadocs/mdx-remote`](https://fumadocs.dev/docs/integrations/content/mdx-remote)), you can preview arbitrary folders of MDX without a build step or `source.config.ts`.

## Multiple docs sites at once

One dev server serves whichever content root you are previewing. When you jump between files in different projects (or different `content/` trees), the extension writes the active root to `.preview-state.json` and the renderer re-reads it on every request.

That means you can live-edit several docs sites in the same VS Code window and the preview follows your active editor — useful when bouncing between repos or content folders during a review.

## Supported out of the box

### Layout & navigation

- Default Fumadocs **docs layout** (sidebar, page title/description, right-hand TOC)
- **`meta.json` / `meta.jsonc`** for sidebar structure, page order, and section titles
- **Lucide icons** in `meta.json` (via `lucideIconsPlugin`)
- YAML **frontmatter** (`title`, `description`, and other fields passed through)
- Site title derived from the **git repo name** of the content root (falls back to "Fumadocs Preview")

### Markdown

Standard markdown rendered with Fumadocs defaults: headings (with anchor links), paragraphs, emphasis, lists, blockquotes, tables, links, horizontal rules, and inline code.

### MDX components

These Fumadocs UI components are injected globally — you can use them without `import` lines:

| Component | Notes |
| --- | --- |
| `Callout` | Includes `CalloutTitle` / `CalloutDescription` compound parts |
| `Tabs` / `Tab` | Tabbed content |
| `Steps` / `Step` | Numbered step flows |
| `Cards` / `Card` | Link cards and grids |
| `Accordions` / `Accordion` | Collapsible sections |
| `Files` / `File` / `Folder` | File-tree display |
| `TypeTable` | Props / type reference tables |
| `Banner` | Top-of-page banners |
| `InlineTOC` | In-page table of contents |
| `CodeBlockTabs` | Tabbed install commands (`CodeBlockTabsList`, `CodeBlockTabsTrigger`, `CodeBlockTab`) |

Plus everything from **`fumadocs-ui/mdx` defaults**: `CodeBlock` (copy button), `Heading`, `Image`, `Table`, etc.

### Code blocks

- **Shiki** syntax highlighting (`github-light` / `github-dark`)
- Titles, line highlights, and word marks (`// [!code highlight]`, `// [!code word:…]`)
- Lazy-loaded languages for fast startup

See the bundled sample content in `webapp/content/` for live examples of each surface.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `fumadocs.contentDirNames` | `["content"]` | Directory names treated as a content root when resolving the nearest root of the previewed file. |

## Not yet supported

This is a **preview** tool, not a drop-in replacement for a production Fumadocs site. The following are intentionally out of scope today:

| Area | Limitation |
| --- | --- |
| **Custom components** | MDX `import` / `export` lines are stripped before compilation. Components from your own project won't resolve — only the built-in Fumadocs components listed above are available. |
| **Custom theming** | Fixed neutral Fumadocs theme and default typography. Your project's CSS variables, color presets, fonts, and Tailwind config are not applied. |
| **Custom layouts** | Always uses the stock `DocsLayout`. Home layouts, notebook layouts, custom nav/footer, and per-site layout props are not configurable. |
| **Build-time pipeline** | No `fumadocs-mdx` / `source.config.ts` / MDX collections. Features that depend on compile-time codegen (e.g. type-safe frontmatter, generated `meta`) won't match production. |
| **OpenAPI / API docs** | `APIPage`, `AutoTypeTable`, and other API-reference integrations are not bundled. |
| **Image zoom & media plugins** | `ImageZoom` and similar optional media components are not included. |
| **Local images** | Relative image paths from your content tree may not resolve. Prefer absolute URLs or paths the dev server can serve. |
| **i18n** | Single locale only. Multi-language routing and translations from a full Fumadocs app are not supported. |
| **Search, analytics, auth** | Production-only features (Pagefind, Orama, PostHog, etc.) are not wired up. |

If you need pixel-perfect parity with a deployed site, run that site's own dev server. Fumadocs Preview is for **rough layout and content review** — fast feedback while writing MDX, especially with collaborators who don't have the full stack installed.

## Commands

| Command | Description |
| --- | --- |
| **Fumadocs: Preview** | Open or focus the side-by-side preview for the active MDX/MD file. |
| **Fumadocs: Open in Browser** | Open the current preview page in your default browser (available while a preview is active). |

## Development

```bash
npm install            # extension dev deps
npm run watch          # rebuild extension on change (F5 to launch in VSCode)
npm run typecheck      # typecheck the extension
npm run package        # build a .vsix

cd webapp
npm install            # the Fumadocs renderer (also done automatically on first preview)
FUMADOCS_CONTENT_ROOT=/abs/path/to/content npm run dev   # run the renderer standalone
```

### Layout

- `src/` — the VS Code extension (root resolution, dev-server lifecycle, webview).
- `webapp/` — the real Fumadocs Next.js app with a fully runtime content source
  (`src/lib/scan.ts` → `src/lib/source.ts`), a runtime MDX compiler
  (`src/lib/compiler.ts`), and a catch-all `/[[...slug]]` route.
- `webapp/content/` — sample pages exercising every supported component (useful for regression checks).

## License

MIT — free to use, modify, and distribute.
