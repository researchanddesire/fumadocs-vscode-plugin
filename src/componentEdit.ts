import * as vscode from "vscode";
import { isMarkdown } from "./markdown";

/**
 * Maps a JSX component tag found in MDX to the builder ("generator") id that
 * knows how to configure it. Only components with a builder in the Docs Tools
 * sidebar (see `docsTools/docsToolsView.ts`) appear here.
 */
const TAG_TO_BUILDER_ID: Record<string, string> = {
  Callout: "callout",
  Banner: "banner",
  Tabs: "tabs",
  Steps: "steps",
  Cards: "cards",
  Accordions: "accordions",
  CodeBlockTabs: "code-block-tabs",
};

interface EditableComponentHit {
  /** Builder id, e.g. "callout". */
  id: string;
  /** Source tag name, e.g. "Callout". */
  tag: string;
  /** Full range of the component block, opening tag through closing tag. */
  range: vscode.Range;
  broken: boolean;
}

const FENCE = /^\s*(```|~~~)/;
const OPEN_TAG = /^\s*<([A-Z][A-Za-z0-9]*)\b/;
const CLOSE_TAG = /^\s*<\/([A-Z][A-Za-z0-9]*)>/;

/**
 * Scan a document for top-level builder-backed component blocks. Nested
 * components (e.g. a Callout inside Tabs) are intentionally skipped so the
 * "Edit in builder" ranges never overlap.
 */
export function findEditableComponents(
  document: vscode.TextDocument,
): EditableComponentHit[] {
  const hits: EditableComponentHit[] = [];
  let inCode = false;
  let line = 0;

  while (line < document.lineCount) {
    const text = document.lineAt(line).text;

    if (FENCE.test(text)) {
      inCode = !inCode;
      line++;
      continue;
    }

    const open = inCode ? null : OPEN_TAG.exec(text);
    const id = open ? TAG_TO_BUILDER_ID[open[1]] : undefined;
    if (!open || !id) {
      const close = inCode ? null : CLOSE_TAG.exec(text);
      const closeId = close ? TAG_TO_BUILDER_ID[close[1]] : undefined;
      if (close && closeId) {
        const startLine = findOrphanStart(document, line);
        hits.push({
          id: closeId,
          tag: close[1],
          range: new vscode.Range(
            startLine,
            document.lineAt(startLine).firstNonWhitespaceCharacterIndex,
            line,
            close.index + close[0].length,
          ),
          broken: true,
        });
      }
      line++;
      continue;
    }

    const tag = open[1];
    const end = findClosingTag(document, line, tag);
    if (!end) {
      const fallbackEnd = findMalformedComponentEnd(document, line);
      const startChar = document.lineAt(line).firstNonWhitespaceCharacterIndex;
      hits.push({
        id,
        tag,
        range: new vscode.Range(
          line,
          startChar,
          fallbackEnd.line,
          fallbackEnd.character,
        ),
        broken: true,
      });
      line = fallbackEnd.line + 1;
      continue;
    }

    const startChar = document.lineAt(line).firstNonWhitespaceCharacterIndex;
    hits.push({
      id,
      tag,
      range: new vscode.Range(line, startChar, end.line, end.character),
      broken: false,
    });

    // Jump past this block so we don't descend into nested matches.
    line = end.line + 1;
  }

  return hits;
}

function findMalformedComponentEnd(
  document: vscode.TextDocument,
  startLine: number,
): { line: number; character: number } {
  for (let line = startLine + 1; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    if (OPEN_TAG.test(text) || /^#{1,6}\s/.test(text)) {
      const prev = Math.max(startLine, line - 1);
      return { line: prev, character: document.lineAt(prev).text.length };
    }
  }

  const lastLine = document.lineCount - 1;
  return { line: lastLine, character: document.lineAt(lastLine).text.length };
}

function findOrphanStart(
  document: vscode.TextDocument,
  closeLine: number,
): number {
  for (let line = closeLine - 1; line >= 0; line--) {
    if (document.lineAt(line).text.trim() === "") return line + 1;
    if (OPEN_TAG.test(document.lineAt(line).text)) return line;
  }
  return closeLine;
}

/** Locate the matching closing tag for `tag` starting at `startLine`. */
function findClosingTag(
  document: vscode.TextDocument,
  startLine: number,
  tag: string,
): { line: number; character: number } | undefined {
  let depth = 0;
  const tokens = new RegExp(String.raw`<${tag}\b|</${tag}>`, "g");

  for (let line = startLine; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    tokens.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = tokens.exec(text))) {
      if (match[0][1] === "/") {
        depth--;
        if (depth === 0) {
          return { line, character: match.index + match[0].length };
        }
      } else {
        depth++;
      }
    }
  }
  return undefined;
}

/**
 * Adds an "Edit in builder" CodeLens above every builder-backed component in
 * an MD/MDX file, opening the Docs Tools generator pre-filled with that
 * component's current values.
 */
export class ComponentEditCodeLensProvider
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

    return findEditableComponents(document).flatMap((hit) => {
      const anchor = new vscode.Range(
        hit.range.start.line,
        hit.range.start.character,
        hit.range.start.line,
        hit.range.start.character,
      );
      const remove = new vscode.CodeLens(anchor, {
        title: `$(trash) Remove ${hit.broken ? "broken " : ""}${hit.tag}`,
        tooltip: "Remove this whole component block",
        command: "fumadocs.removeComponent",
        arguments: [document.uri, hit.range],
      });
      if (hit.broken) return [remove];
      return [
        new vscode.CodeLens(anchor, {
          title: `$(edit) Edit ${hit.tag} in builder`,
          tooltip: "Open this component in the Fumadocs builder",
          command: "fumadocs.editComponent",
          arguments: [document.uri, hit.id, hit.range],
        }),
        remove,
      ];
    });
  }
}

export async function removeComponentBlock(
  uri: vscode.Uri,
  range: vscode.Range,
): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  let startLine = Math.min(range.start.line, doc.lineCount - 1);
  let endLine = Math.min(range.end.line, doc.lineCount - 1);

  if (startLine > 0 && doc.lineAt(startLine - 1).text.trim() === "") {
    startLine--;
  } else if (
    endLine + 1 < doc.lineCount &&
    doc.lineAt(endLine + 1).text.trim() === ""
  ) {
    endLine++;
  }

  const start = new vscode.Position(startLine, 0);
  const end =
    endLine + 1 < doc.lineCount
      ? new vscode.Position(endLine + 1, 0)
      : doc.lineAt(endLine).range.end;
  const edit = new vscode.WorkspaceEdit();
  edit.delete(uri, new vscode.Range(start, end));
  await vscode.workspace.applyEdit(edit);
}
