import * as fs from "fs";
import * as path from "path";

/**
 * A single entry in a meta.json `pages` array, parsed into a typed shape.
 * Mirrors the Fumadocs page conventions:
 * https://www.fumadocs.dev/docs/headless/page-conventions#pages
 */
export type PagesItem =
  | { kind: "path"; value: string }
  | { kind: "separator"; label: string; icon?: string }
  | { kind: "link"; text: string; url: string; icon?: string; external: boolean }
  | { kind: "rest" }
  | { kind: "reversed-rest" }
  | { kind: "extract"; value: string }
  | { kind: "except"; value: string };

/** Parsed, editable representation of a `meta.json` / `meta.jsonc` file. */
export interface MetaDoc {
  /** Preserved `$schema` value, if present. */
  schema?: string;
  title?: string;
  description?: string;
  icon?: string;
  root?: boolean;
  defaultOpen?: boolean;
  collapsible?: boolean;
  pagesIndex?: string;
  /** Present only when the source file actually had a `pages` key. */
  pages?: PagesItem[];
  /** Any keys we don't model, preserved verbatim on serialize. */
  extra: Record<string, unknown>;
}

/** A page or subfolder discovered on disk inside a content folder. */
export interface FolderEntry {
  /** The reference token used in `pages` (bare slug / folder name). */
  slug: string;
  type: "page" | "folder";
  /** Absolute path on disk. */
  absolutePath: string;
}

const PAGE_EXTENSIONS = new Set([".md", ".mdx"]);
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".source",
  ".turbo",
  "dist",
  "out",
]);

const CANONICAL_KEY_ORDER = [
  "title",
  "description",
  "icon",
  "root",
  "defaultOpen",
  "collapsible",
  "pagesIndex",
] as const;

/** Tolerate `.jsonc`-style comments before JSON parsing. */
function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Parse a `meta.json` source string into a {@link MetaDoc}. Returns `null` when
 * the JSON is malformed so callers can surface a diagnostic instead of crashing.
 */
export function parseMeta(raw: string): MetaDoc | null {
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stripJsonComments(raw));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const known = new Set<string>([
    "$schema",
    "title",
    "description",
    "icon",
    "root",
    "defaultOpen",
    "collapsible",
    "pagesIndex",
    "pages",
  ]);

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!known.has(key)) extra[key] = value;
  }

  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  const bool = (v: unknown): boolean | undefined =>
    typeof v === "boolean" ? v : undefined;

  const pages = Array.isArray(obj.pages)
    ? obj.pages
        .filter((p): p is string => typeof p === "string")
        .map(classifyPagesItem)
    : undefined;

  return {
    schema: str(obj.$schema),
    title: str(obj.title),
    description: str(obj.description),
    icon: str(obj.icon),
    root: bool(obj.root),
    defaultOpen: bool(obj.defaultOpen),
    collapsible: bool(obj.collapsible),
    pagesIndex: str(obj.pagesIndex),
    pages,
    extra,
  };
}

/** An empty meta doc (used when creating a new file). */
export function emptyMeta(): MetaDoc {
  return { extra: {} };
}

const SEPARATOR_RE = /^---(?:\[([^\]]+)\])?([\s\S]*?)---$/;
const LINK_RE = /^(external:)?(?:\[([^\]]+)\])?\[([^\]]+)\]\(([^)]+)\)$/;

/** Classify a raw `pages` string into a typed {@link PagesItem}. */
function classifyPagesItem(raw: string): PagesItem {
  const value = raw.trim();

  if (value === "...") return { kind: "rest" };
  if (value === "z...a") return { kind: "reversed-rest" };
  if (value.startsWith("...")) {
    return { kind: "extract", value: value.slice(3) };
  }
  if (value.startsWith("!")) {
    return { kind: "except", value: value.slice(1) };
  }

  const sep = SEPARATOR_RE.exec(value);
  if (sep) {
    return {
      kind: "separator",
      icon: sep[1] ? sep[1].trim() : undefined,
      label: sep[2].trim(),
    };
  }

  if (value.includes("](")) {
    const link = LINK_RE.exec(value);
    if (link) {
      return {
        kind: "link",
        external: Boolean(link[1]),
        icon: link[2] ? link[2].trim() : undefined,
        text: link[3],
        url: link[4],
      };
    }
  }

  return { kind: "path", value };
}

/** Serialize a typed {@link PagesItem} back to its `pages` string form. */
function serializePagesItem(item: PagesItem): string {
  switch (item.kind) {
    case "path":
      return item.value;
    case "rest":
      return "...";
    case "reversed-rest":
      return "z...a";
    case "extract":
      return `...${item.value}`;
    case "except":
      return `!${item.value}`;
    case "separator": {
      const icon = item.icon ? `[${item.icon}]` : "";
      return `---${icon}${item.label}---`;
    }
    case "link": {
      const prefix = item.external ? "external:" : "";
      const icon = item.icon ? `[${item.icon}]` : "";
      return `${prefix}${icon}[${item.text}](${item.url})`;
    }
  }
}

/**
 * Serialize a {@link MetaDoc} to pretty-printed JSON (2-space indent, trailing
 * newline). Undefined fields are omitted; `$schema` and unknown keys are kept.
 */
export function serializeMeta(doc: MetaDoc): string {
  const out: Record<string, unknown> = {};
  if (doc.schema !== undefined) out.$schema = doc.schema;
  for (const key of CANONICAL_KEY_ORDER) {
    const v = doc[key];
    if (v !== undefined) out[key] = v;
  }
  if (doc.pages !== undefined) {
    out.pages = doc.pages.map(serializePagesItem);
  }
  for (const [key, value] of Object.entries(doc.extra)) {
    out[key] = value;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Strip a leading `./` and any trailing `/` from a path reference. */
function normalizeRef(value: string): string {
  return value.replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * List the immediate pages and subfolders inside `folderDir` that can appear in
 * that folder's `meta.json` `pages` array. Page slugs are basenames without the
 * extension; folders use their directory name.
 */
export function discoverFolderItems(folderDir: string): FolderEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folderDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const items: FolderEntry[] = [];
  for (const entry of entries) {
    const abs = path.join(folderDir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      items.push({ slug: entry.name, type: "folder", absolutePath: abs });
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!PAGE_EXTENSIONS.has(ext)) continue;
    const slug = path.basename(entry.name, ext);
    items.push({ slug, type: "page", absolutePath: abs });
  }

  // Stable, predictable order: index first, then alphabetical.
  items.sort((a, b) => {
    if (a.slug === "index") return -1;
    if (b.slug === "index") return 1;
    return a.slug.localeCompare(b.slug);
  });
  return items;
}

/** True when the `pages` array contains a rest item (`...` or `z...a`). */
function hasRestItem(pages: PagesItem[]): boolean {
  return pages.some(
    (p) => p.kind === "rest" || p.kind === "reversed-rest",
  );
}

/** The set of bare reference tokens explicitly named by `pages`. */
function referencedSlugs(pages: PagesItem[]): Set<string> {
  const refs = new Set<string>();
  for (const item of pages) {
    if (item.kind === "path" || item.kind === "extract") {
      refs.add(normalizeRef(item.value));
    }
  }
  return refs;
}

export interface MetaIssues {
  /** Folder entries excluded from an explicit `pages` array (no rest item). */
  missing: FolderEntry[];
  /** Simple single-segment `pages` paths that don't exist on disk. */
  dangling: string[];
}

/**
 * Compare an explicit `pages` array against what actually exists in the folder.
 * When a rest item is present nothing is "missing" (Fumadocs auto-includes the
 * remainder). Only single-segment path references are checked for dangling.
 */
export function computeMetaIssues(
  doc: MetaDoc,
  entries: FolderEntry[],
): MetaIssues {
  if (!doc.pages) return { missing: [], dangling: [] };

  const refs = referencedSlugs(doc.pages);
  const rest = hasRestItem(doc.pages);
  const existing = new Set(entries.map((e) => e.slug));

  const missing = rest
    ? []
    : entries.filter((e) => !refs.has(e.slug));

  const dangling: string[] = [];
  for (const item of doc.pages) {
    if (item.kind !== "path") continue;
    const ref = normalizeRef(item.value);
    if (ref.includes("/")) continue; // nested paths aren't validated
    if (!existing.has(ref)) dangling.push(ref);
  }

  return { missing, dangling };
}
