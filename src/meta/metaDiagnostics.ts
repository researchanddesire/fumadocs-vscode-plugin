import * as path from "path";
import * as vscode from "vscode";
import {
  computeMetaIssues,
  discoverFolderItems,
  parseMeta,
  type MetaDoc,
  type PagesItem,
} from "./metaModel";
import { isMetaFile } from "./metaCodeLens";
import { readMetaDoc, resolveMetaUri, writeMetaDoc } from "./metaWrite";

const META_DIAGNOSTIC_SOURCE = "Fumadocs";

/**
 * Recompute and publish diagnostics for a meta file: pages that exist on disk
 * but are excluded from an explicit `pages` array, and `pages` entries that
 * point at files that don't exist. Uses the live (possibly unsaved) buffer.
 */
export async function refreshMetaDiagnostics(
  collection: vscode.DiagnosticCollection,
  uri: vscode.Uri,
): Promise<void> {
  if (!isMetaFile(uri)) return;

  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch {
    collection.delete(uri);
    return;
  }

  const text = document.getText();
  const top = new vscode.Range(0, 0, 0, 0);

  const doc = parseMeta(text);
  if (!doc) {
    collection.set(uri, [
      new vscode.Diagnostic(
        top,
        "Invalid JSON — this meta file can't be parsed.",
        vscode.DiagnosticSeverity.Error,
      ),
    ]);
    return;
  }

  if (!doc.pages) {
    collection.delete(uri);
    return;
  }

  const folderDir = path.dirname(uri.fsPath);
  const entries = discoverFolderItems(folderDir);
  const { missing, dangling } = computeMetaIssues(doc, entries);
  const diagnostics: vscode.Diagnostic[] = [];

  const pagesRange = locate(document, text, '"pages"') ?? top;
  for (const entry of missing) {
    const d = new vscode.Diagnostic(
      pagesRange,
      `"${entry.slug}" exists in this folder but isn't in "pages", so it won't appear in the sidebar.`,
      vscode.DiagnosticSeverity.Warning,
    );
    d.source = META_DIAGNOSTIC_SOURCE;
    diagnostics.push(d);
  }

  for (const ref of dangling) {
    const range = locate(document, text, `"${ref}"`) ?? pagesRange;
    const d = new vscode.Diagnostic(
      range,
      `"pages" references "${ref}", which doesn't exist in this folder.`,
      vscode.DiagnosticSeverity.Warning,
    );
    d.source = META_DIAGNOSTIC_SOURCE;
    diagnostics.push(d);
  }

  collection.set(uri, diagnostics);
}

/** Best-effort range of the first occurrence of `needle` in the document. */
function locate(
  document: vscode.TextDocument,
  text: string,
  needle: string,
): vscode.Range | null {
  const idx = text.indexOf(needle);
  if (idx < 0) return null;
  return new vscode.Range(
    document.positionAt(idx),
    document.positionAt(idx + needle.length),
  );
}

/** Provides quick fixes for meta diagnostics (add missing / remove dangling). */
export class MetaCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
  ): vscode.CodeAction[] {
    if (!isMetaFile(document.uri)) return [];

    const doc = parseMeta(document.getText());
    if (!doc?.pages) return [];

    const folderDir = path.dirname(document.uri.fsPath);
    const entries = discoverFolderItems(folderDir);
    const { missing, dangling } = computeMetaIssues(doc, entries);
    if (missing.length === 0 && dangling.length === 0) return [];

    const actions: vscode.CodeAction[] = [];

    if (missing.length > 0) {
      const slugs = missing.map((m) => m.slug);
      actions.push(
        command(
          `Add all ${missing.length} missing page(s) to "pages"`,
          "fumadocs.meta.addPages",
          [folderDir, slugs],
          true,
        ),
        command(
          'Add "..." to include the rest automatically',
          "fumadocs.meta.addRest",
          [folderDir],
        ),
      );
      for (const m of missing) {
        actions.push(
          command(
            `Add "${m.slug}" to "pages"`,
            "fumadocs.meta.addPages",
            [folderDir, [m.slug]],
          ),
        );
      }
    }

    for (const ref of dangling) {
      actions.push(
        command(
          `Remove "${ref}" from "pages"`,
          "fumadocs.meta.removeRefs",
          [folderDir, [ref]],
        ),
      );
    }

    return actions;
  }
}

function command(
  title: string,
  commandId: string,
  args: unknown[],
  isPreferred = false,
): vscode.CodeAction {
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  action.command = { title, command: commandId, arguments: args };
  action.isPreferred = isPreferred;
  return action;
}

/**
 * Append page items for `slugs` not already referenced, creating the `pages`
 * array (seeded from the folder's current items) if it doesn't exist yet.
 */
export async function addPages(
  folderDir: string,
  slugs: string[],
): Promise<void> {
  const base = readMetaDoc(folderDir);
  const doc: MetaDoc = base ?? { extra: {} };

  if (!doc.pages) {
    doc.pages = discoverFolderItems(folderDir).map(
      (e): PagesItem => ({ kind: "path", value: e.slug }),
    );
  }

  const present = new Set(
    doc.pages
      .filter((p): p is { kind: "path"; value: string } => p.kind === "path")
      .map((p) => p.value),
  );
  for (const slug of slugs) {
    if (!present.has(slug)) {
      doc.pages.push({ kind: "path", value: slug });
      present.add(slug);
    }
  }

  await writeMetaDoc(resolveMetaUri(folderDir), doc);
}

/** Append a rest (`...`) item so leftover pages are auto-included. */
export async function addRest(folderDir: string): Promise<void> {
  const doc: MetaDoc = readMetaDoc(folderDir) ?? { extra: {} };
  if (!doc.pages) doc.pages = [];
  if (!doc.pages.some((p) => p.kind === "rest" || p.kind === "reversed-rest")) {
    doc.pages.push({ kind: "rest" });
  }
  await writeMetaDoc(resolveMetaUri(folderDir), doc);
}

/** Remove `pages` path items whose value matches one of `refs`. */
export async function removeRefs(
  folderDir: string,
  refs: string[],
): Promise<void> {
  const doc = readMetaDoc(folderDir);
  if (!doc?.pages) return;
  const drop = new Set(refs);
  doc.pages = doc.pages.filter(
    (p) => !(p.kind === "path" && drop.has(p.value)),
  );
  await writeMetaDoc(resolveMetaUri(folderDir), doc);
}

/**
 * Auto-include a newly created page in its folder's meta `pages` list, but only
 * when that list exists, is explicit, and has no rest item (so the page would
 * otherwise silently disappear from the sidebar). No-op otherwise.
 */
export async function autoIncludeNewPage(uri: vscode.Uri): Promise<void> {
  const folderDir = path.dirname(uri.fsPath);
  const doc = readMetaDoc(folderDir);
  if (!doc?.pages) return; // no explicit pages list -> nothing to maintain
  if (doc.pages.some((p) => p.kind === "rest" || p.kind === "reversed-rest")) {
    return; // rest already covers it
  }

  const ext = path.extname(uri.fsPath).toLowerCase();
  if (ext !== ".md" && ext !== ".mdx") return;
  const slug = path.basename(uri.fsPath, ext);

  const referenced = doc.pages.some(
    (p) => p.kind === "path" && p.value === slug,
  );
  if (referenced) return;

  await addPages(folderDir, [slug]);
}
