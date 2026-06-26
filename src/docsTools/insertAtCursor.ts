import * as path from "path";
import * as vscode from "vscode";
import { isMarkdownEditor } from "../markdown";

/** Build markdown or MDX image markup for the active file. */
export function imageMarkup(relPath: string, alt: string): string {
  const editor = vscode.window.activeTextEditor;
  const ext = editor
    ? path.extname(editor.document.uri.fsPath).toLowerCase()
    : ".mdx";
  const safeAlt = alt.replace(/"/g, '\\"');
  if (ext === ".mdx") {
    return `<img src="${relPath}" alt="${safeAlt}" />`;
  }
  return `![${alt}](${relPath})`;
}

interface LineMeta {
  /** Whether the line is inside (or is the boundary of) a fenced code block. */
  inCode: boolean;
  /** Approx. JSX nesting depth at the start of the line. */
  depth: number;
  blank: boolean;
}

interface InsertTarget {
  line: number;
  atEof: boolean;
}

/**
 * Insert a block-level `snippet` at the nearest "free" line at or below the
 * cursor — never inside a fenced code block or in the middle of a JSX
 * component — keeping blank-line separation around the inserted block.
 */
export async function insertBlockBelowCursor(snippet: string): Promise<boolean> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isMarkdownEditor(editor)) {
    void vscode.window.showWarningMessage(
      "Open a Markdown or MDX file to insert content.",
    );
    return false;
  }

  const doc = editor.document;
  const meta = buildLineMeta(doc);
  const cursorLine = editor.selection.active.line;
  const target = findSafeInsertLine(meta, doc, cursorLine);
  const block = normalizeSnippet(snippet);

  const { range, text, snippetStartLine } = buildEdit(doc, target, block);

  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, range, text);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) return false;

  const startPos = new vscode.Position(snippetStartLine, 0);
  editor.selection = new vscode.Selection(startPos, startPos);
  editor.revealRange(
    new vscode.Range(startPos, startPos),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport,
  );
  return true;
}

/**
 * Tidy a generated snippet before it lands in the document: normalize line
 * endings, drop trailing whitespace, and collapse runs of blank lines to a
 * single separator — while leaving the contents of fenced code blocks alone.
 */
function normalizeSnippet(snippet: string): string {
  const lines = snippet.replaceAll(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inCode = false;
  let pendingBlank = false;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const isFence = /^\s*(```|~~~)/.test(line);

    if (isFence) {
      if (pendingBlank && out.length > 0) out.push("");
      pendingBlank = false;
      out.push(line);
      inCode = !inCode;
      continue;
    }

    if (!inCode && line.trim() === "") {
      // Defer blank lines so multiple in a row collapse to at most one.
      if (out.length > 0) pendingBlank = true;
      continue;
    }

    if (pendingBlank) out.push("");
    pendingBlank = false;
    out.push(line);
  }

  return out.join("\n");
}

function buildLineMeta(doc: vscode.TextDocument): LineMeta[] {
  const meta: LineMeta[] = [];
  let inCode = false;
  let depth = 0;

  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    meta.push({ inCode, depth, blank: text.trim() === "" });

    const isFence = /^\s*(```|~~~)/.test(text);
    if (isFence) {
      inCode = !inCode;
      continue;
    }
    if (!inCode) {
      depth = Math.max(0, depth + jsxDelta(text));
    }
  }
  return meta;
}

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

function findSafeInsertLine(
  meta: LineMeta[],
  doc: vscode.TextDocument,
  cursorLine: number,
): InsertTarget {
  const lineCount = doc.lineCount;
  let i = Math.min(Math.max(cursorLine, 0), lineCount - 1);

  // If the cursor sits inside a code block, step past its closing fence.
  while (i < lineCount && meta[i].inCode) i++;

  for (let j = i; j < lineCount; j++) {
    const m = meta[j];
    if (m.blank && !m.inCode && m.depth === 0) {
      return { line: j, atEof: false };
    }
  }
  return { line: lineCount - 1, atEof: true };
}

function buildEdit(
  doc: vscode.TextDocument,
  target: InsertTarget,
  block: string,
): { range: vscode.Range; text: string; snippetStartLine: number } {
  if (target.atEof) {
    const lastLine = doc.lineCount - 1;
    const lastText = doc.lineAt(lastLine).text;
    const prefix = lastText.trim() === "" ? "\n" : "\n\n";
    const pos = new vscode.Position(lastLine, lastText.length);
    const text = `${prefix}${block}\n`;
    const leading = prefix.length;
    return {
      range: new vscode.Range(pos, pos),
      text,
      snippetStartLine: lastLine + leading,
    };
  }

  const i = target.line;
  const needLeadingBlank = i > 0 && doc.lineAt(i - 1).text.trim() !== "";
  const text = `${needLeadingBlank ? "\n" : ""}${block}\n`;
  const pos = new vscode.Position(i, 0);
  return {
    range: new vscode.Range(pos, pos),
    text,
    snippetStartLine: i + (needLeadingBlank ? 1 : 0),
  };
}
