import * as vscode from "vscode";
import { detectConversions } from "./convert/detectors";

/**
 * Apply every detected Markdown -> component conversion in the active document
 * at once. The interactive per-block conversions live in the preview; this
 * command is a quick "convert the whole file" helper.
 */
export const convertAll = async (): Promise<void> => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("Open an MDX file first.");
    return;
  }

  const document = editor.document;
  const conversions = detectConversions(document.getText());
  if (conversions.length === 0) {
    void vscode.window.showInformationMessage(
      "No Markdown blocks to convert were found.",
    );
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  // Apply from the bottom up so earlier offsets stay valid.
  for (const conversion of [...conversions].reverse()) {
    edit.replace(
      document.uri,
      new vscode.Range(
        document.positionAt(conversion.start),
        document.positionAt(conversion.end),
      ),
      conversion.replacement,
    );
  }

  await vscode.workspace.applyEdit(edit);
  void vscode.window.showInformationMessage(
    `Converted ${conversions.length} block${conversions.length === 1 ? "" : "s"} to Fumadocs components.`,
  );
};
