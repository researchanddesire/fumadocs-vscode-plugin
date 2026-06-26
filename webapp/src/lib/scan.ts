import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { VirtualFile } from 'fumadocs-core/source';

const PAGE_EXTENSIONS = new Set(['.md', '.mdx']);
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.source',
  '.turbo',
  'dist',
  'out',
]);

export interface PageFileData {
  title: string;
  description?: string;
  /** Raw file content (including frontmatter) to compile at request time. */
  content: string;
  /** Absolute path on disk, used for relative-image resolution and links. */
  absolutePath: string;
  [key: string]: unknown;
}

function titleFromFilename(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath));
  if (base === 'index') {
    const parent = path.basename(path.dirname(filePath));
    return humanize(parent || 'Home');
  }
  return humanize(base);
}

function humanize(value: string): string {
  const cleaned = value.replace(/[-_]+/g, ' ').trim();
  if (!cleaned) return value;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Recursively scan a directory into Fumadocs virtual files (pages + meta).
 * Reads the filesystem fresh on every call so edits show up on reload.
 */
export function scanContentRoot(root: string): VirtualFile[] {
  const files: VirtualFile[] = [];
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return files;
  }

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      const relPath = path.relative(root, abs).split(path.sep).join('/');

      if (PAGE_EXTENSIONS.has(ext)) {
        const raw = safeRead(abs);
        if (raw == null) continue;
        const parsed = safeParseFrontmatter(raw);
        const fm = parsed.data as Record<string, unknown>;
        const data: PageFileData = {
          ...fm,
          title:
            typeof fm.title === 'string' && fm.title.trim().length > 0
              ? fm.title
              : titleFromFilename(abs),
          description:
            typeof fm.description === 'string' ? fm.description : undefined,
          content: raw,
          absolutePath: abs,
        };
        files.push({ type: 'page', path: relPath, absolutePath: abs, data });
      } else if (entry.name === 'meta.json' || entry.name === 'meta.jsonc') {
        const raw = safeRead(abs);
        if (raw == null) continue;
        try {
          const data = JSON.parse(stripJsonComments(raw));
          files.push({ type: 'meta', path: relPath, absolutePath: abs, data });
        } catch {
          // Ignore malformed meta files instead of crashing the whole tree.
        }
      }
    }
  };

  walk(root);
  return files;
}

function safeRead(abs: string): string | null {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function safeParseFrontmatter(raw: string): { data: Record<string, unknown> } {
  try {
    const parsed = matter(raw);
    return { data: parsed.data as Record<string, unknown> };
  } catch {
    return { data: {} };
  }
}

function stripJsonComments(input: string): string {
  // Minimal tolerance for `.jsonc`-style comments in meta files.
  return input
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
