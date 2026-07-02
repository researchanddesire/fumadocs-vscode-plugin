import * as vscode from "vscode";
import { isMarkdownEditor } from "../markdown";
import { createBlockInsertionPlan, PlanRange } from "./insertPlan";

/**
 * Insert a block-level `snippet` at the nearest "free" line at or below the
 * cursor — never inside a fenced code block or in the middle of a JSX
 * component — keeping blank-line separation around the inserted block.
 *
 * Returns the range the inserted block occupies in the document (so callers
 * can keep editing it live), or null if nothing was inserted. Pass
 * `targetEditor` to insert into a specific editor rather than the active one.
 */
export async function insertBlockBelowCursor(
  snippet: string,
  targetEditor?: vscode.TextEditor,
): Promise<{ range: vscode.Range } | null> {
  const editor = targetEditor ?? vscode.window.activeTextEditor;
  if (!editor || !isMarkdownEditor(editor)) {
    void vscode.window.showWarningMessage(
      "Open a Markdown or MDX file to insert content.",
    );
    return null;
  }

  const doc = editor.document;
  const anchorLine = editor.selection.isEmpty
    ? editor.selection.active.line
    : editor.selection.end.line;
  const plan = createBlockInsertionPlan(documentLines(doc), anchorLine, snippet);

  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, toRange(plan.range), plan.text);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) return null;

  const startPos = new vscode.Position(plan.snippetStartLine, 0);
  editor.selection = new vscode.Selection(startPos, startPos);
  editor.revealRange(
    new vscode.Range(startPos, startPos),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport,
  );

  return { range: toRange(plan.insertedRange) };
}

export function toRange(range: PlanRange): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

export function documentLines(doc: vscode.TextDocument): { text: string }[] {
  const lines: { text: string }[] = [];
  for (let i = 0; i < doc.lineCount; i++) lines.push({ text: doc.lineAt(i).text });
  return lines;
}
