export interface ComponentCatalogItem {
  id: string;
  label: string;
  description: string;
  /** When true, clicking opens the configuration dialog instead of inserting. */
  configurable: boolean;
  /** Literal snippet inserted directly for non-configurable components. */
  snippet?: string;
}

export const FUMADOCS_COMPONENT_MIME =
  "application/vnd.code.fumadocs.component";

/**
 * The Fumadocs default components surfaced in the sidebar. Configurable ones
 * open the in-sidebar builder overlay (see `docsToolsView.ts`); the rest
 * insert a fixed starter snippet.
 */
export const FUMADOCS_COMPONENTS: ComponentCatalogItem[] = [
  {
    id: "callout",
    label: "Callout",
    description: "Info, warn, error, success, or idea block",
    configurable: true,
  },
  {
    id: "tabs",
    label: "Tabs",
    description: "Tabbed content",
    configurable: true,
  },
  {
    id: "steps",
    label: "Steps",
    description: "Numbered procedural steps",
    configurable: true,
  },
  {
    id: "cards",
    label: "Cards",
    description: "Link card grid",
    configurable: true,
  },
  {
    id: "accordions",
    label: "Accordions",
    description: "Collapsible FAQ sections",
    configurable: true,
  },
  {
    id: "banner",
    label: "Banner",
    description: "Dismissible announcement strip",
    configurable: true,
  },
  {
    id: "code-block-tabs",
    label: "CodeBlockTabs",
    description: "Tabbed install commands / code",
    configurable: true,
  },
  {
    id: "codeblock",
    label: "Code block",
    description: "Fenced code with language + title",
    configurable: true,
  },
  {
    id: "table",
    label: "Table",
    description: "Grid with rows, columns, alignment",
    configurable: true,
  },
  {
    id: "files",
    label: "Files",
    description: "File tree visualization",
    configurable: false,
    snippet: `<Files>
  <Folder name="src" defaultOpen>
    <File name="index.ts" />
    <File name="utils.ts" />
  </Folder>
  <File name="README.md" />
</Files>`,
  },
  {
    id: "type-table",
    label: "TypeTable",
    description: "Props / API reference table",
    configurable: false,
    snippet: `<TypeTable
  type={{
    name: {
      description: 'Display name.',
      type: 'string',
      required: true,
    },
    enabled: {
      description: 'Whether the feature is active.',
      type: 'boolean',
      default: 'true',
    },
  }}
/>`,
  },
  {
    id: "inline-toc",
    label: "InlineTOC",
    description: "In-page table of contents",
    configurable: false,
    snippet: `<InlineTOC
  items={[
    { title: 'Section one', url: '#section-one', depth: 1 },
    { title: 'Subsection', url: '#subsection', depth: 2 },
  ]}
/>`,
  },
];

export function getComponent(id: string): ComponentCatalogItem | undefined {
  return FUMADOCS_COMPONENTS.find((c) => c.id === id);
}
