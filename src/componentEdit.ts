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
}

const FENCE = /^\s*(```|~~~)/;
const OPEN_TAG = /^\s*<([A-Z][A-Za-z0-9]*)\b/;

/**
 * Scan a document for top-level builder-backed component blocks. Nested
 * components (e.g. a Callout inside Tabs) are intentionally skipped so the
 * "Edit in builder" ranges never overlap.
 */
function findEditableComponents(
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
      line++;
      continue;
    }

    const tag = open[1];
    const end = findClosingTag(document, line, tag);
    if (!end) {
      line++;
      continue;
    }

    const startChar = document.lineAt(line).firstNonWhitespaceCharacterIndex;
    hits.push({
      id,
      tag,
      range: new vscode.Range(line, startChar, end.line, end.character),
    });

    // Jump past this block so we don't descend into nested matches.
    line = end.line + 1;
  }

  return hits;
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

    return findEditableComponents(document).map((hit) => {
      const anchor = new vscode.Range(
        hit.range.start.line,
        hit.range.start.character,
        hit.range.start.line,
        hit.range.start.character,
      );
      return new vscode.CodeLens(anchor, {
        title: `$(edit) Edit ${hit.tag} in builder`,
        tooltip: "Open this component in the Fumadocs builder",
        command: "fumadocs.editComponent",
        arguments: [document.uri, hit.id, hit.range],
      });
    });
  }
}
