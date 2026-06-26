import * as vscode from "vscode";
import { isMarkdown } from "./markdown";

/** A detected markdown block (code fence or GFM table) editable in a builder. */
interface MarkdownBlockHit {
  /** Builder id, matching a definition in the Docs Tools sidebar webview. */
  id: "codeblock" | "table";
  /** Human label used in the CodeLens title. */
  label: string;
  /** Full range of the block (replaced when saving edits). */
  range: vscode.Range;
}

/** A block match plus the line the scanner should resume at. */
interface ScanResult {
  hit?: MarkdownBlockHit;
  next: number;
}

// Opening or closing fence: optional indent, ``` or ~~~, optional info string.
const FENCE = /^(\s*)(```|~~~)(.*)$/;

/** Net change in JSX element depth contributed by a single line. */
function jsxDelta(line: string): number {
  let delta = 0;
  const opens = line.match(/<[A-Za-z][\w.]*(\s[^<>]*?)?>/g) || [];
  for (const tag of opens) {
    if (!tag.endsWith("/>")) delta++;
  }
  const closes = line.match(/<\/[A-Za-z][\w.]*>/g) || [];
  delta -= closes.length;
  return delta;
}

/** Strip the leading/trailing border pipes and split a table row into cells. */
function stripBorders(line: string): string {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s;
}

/** Whether a line is a GFM table delimiter row, e.g. `| --- | :--: |`. */
function isDelimiterRow(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|") && !/^:?-+:?$/.test(t)) return false;
  const cells = stripBorders(t)
    .split("|")
    .map((c) => c.trim());
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-+:?$/.test(c));
}

/** Whether a line looks like a table row (contains a pipe and isn't blank). */
function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim() !== "";
}

/** Build a hit spanning whole lines from `startLine` to `endLine`. */
function blockHit(
  document: vscode.TextDocument,
  id: MarkdownBlockHit["id"],
  label: string,
  startLine: number,
  endLine: number,
): MarkdownBlockHit {
  return {
    id,
    label,
    range: new vscode.Range(
      startLine,
      document.lineAt(startLine).firstNonWhitespaceCharacterIndex,
      endLine,
      document.lineAt(endLine).text.length,
    ),
  };
}

/** Consume a fenced code block starting at `line`; only emits a hit at depth 0. */
function scanFence(
  document: vscode.TextDocument,
  line: number,
  marker: string,
  depth: number,
): ScanResult {
  const n = document.lineCount;
  let end = line + 1;
  while (end < n && !document.lineAt(end).text.trim().startsWith(marker)) {
    end++;
  }
  const closeLine = end < n ? end : n - 1;
  const hit =
    depth === 0
      ? blockHit(document, "codeblock", "code block", line, closeLine)
      : undefined;
  return { hit, next: closeLine + 1 };
}

/** Consume a GFM table starting at its header `line`. */
function scanTable(
  document: vscode.TextDocument,
  line: number,
): ScanResult {
  const n = document.lineCount;
  let end = line + 2;
  while (
    end < n &&
    isTableRow(document.lineAt(end).text) &&
    !FENCE.test(document.lineAt(end).text)
  ) {
    end++;
  }
  return { hit: blockHit(document, "table", "table", line, end - 1), next: end };
}

/** Whether the line at `line` begins a GFM table (header + delimiter rows). */
function startsTable(document: vscode.TextDocument, line: number): boolean {
  const n = document.lineCount;
  const text = document.lineAt(line).text;
  if (!isTableRow(text) || isDelimiterRow(text)) return false;
  return line + 1 < n && isDelimiterRow(document.lineAt(line + 1).text);
}

/**
 * Scan a document for top-level fenced code blocks and GFM tables. Blocks
 * nested inside a JSX component (e.g. the fences inside `CodeBlockTabs`) are
 * skipped so they never compete with that component's own builder.
 */
function findEditableBlocks(
  document: vscode.TextDocument,
): MarkdownBlockHit[] {
  const hits: MarkdownBlockHit[] = [];
  const n = document.lineCount;
  let depth = 0;
  let line = 0;

  while (line < n) {
    const text = document.lineAt(line).text;
    const fence = FENCE.exec(text);

    if (fence) {
      const result = scanFence(document, line, fence[2], depth);
      if (result.hit) hits.push(result.hit);
      line = result.next;
      continue;
    }

    if (depth === 0 && startsTable(document, line)) {
      const result = scanTable(document, line);
      if (result.hit) hits.push(result.hit);
      line = result.next;
      continue;
    }

    depth = Math.max(0, depth + jsxDelta(text));
    line++;
  }

  return hits;
}

/**
 * Adds an "Edit code block" / "Edit table" CodeLens above every fenced code
 * block and GFM table in an MD/MDX file, opening the matching builder in the
 * Docs Tools sidebar pre-filled with the block's current contents.
 */
export class MarkdownBlockEditCodeLensProvider
  implements vscode.CodeLensProvider
{
  private readonly onDidChangeCodeLensesEmitter =
    new vscode.EventEmitter<void>();

  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  refresh(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isMarkdown(document)) return [];

    return findEditableBlocks(document).map((hit) => {
      const anchor = new vscode.Range(
        hit.range.start.line,
        hit.range.start.character,
        hit.range.start.line,
        hit.range.start.character,
      );
      return new vscode.CodeLens(anchor, {
        title: `$(edit) Edit ${hit.label}`,
        tooltip: `Open this ${hit.label} in the Fumadocs builder`,
        command: "fumadocs.editComponent",
        arguments: [document.uri, hit.id, hit.range],
      });
    });
  }
}
