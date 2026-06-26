import * as vscode from "vscode";
import { isMarkdownEditor } from "../markdown";

/** Insert `text` at the active cursor, replacing any non-empty selection. */
export async function insertAtCursor(text: string): Promise<boolean> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isMarkdownEditor(editor)) {
    void vscode.window.showWarningMessage(
      "Open a Markdown or MDX file to insert content.",
    );
    return false;
  }

  const { document, selection } = editor;
  const edit = new vscode.WorkspaceEdit();
  const range =
    selection.isEmpty
      ? new vscode.Range(selection.active, selection.active)
      : selection;
  edit.replace(document.uri, range, text);

  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) return false;

  const lines = text.split("\n");
  const endLine = range.start.line + lines.length - 1;
  const endChar =
    lines.length === 1
      ? range.start.character + text.length
      : lines[lines.length - 1].length;
  const newPos = new vscode.Position(endLine, endChar);
  editor.selection = new vscode.Selection(newPos, newPos);
  editor.revealRange(new vscode.Range(newPos, newPos));
  return true;
}
