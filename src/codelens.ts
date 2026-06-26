import * as vscode from "vscode";
import { isMarkdown } from "./markdown";

/**
 * Clickable Preview actions at the top of every MD/MDX file.
 */
export class PreviewCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeCodeLensesEmitter =
    new vscode.EventEmitter<void>();

  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  refresh(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isMarkdown(document)) return [];

    const top = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(top, {
        title: "$(open-preview) Preview",
        tooltip: "Open Fumadocs preview to the side (Cmd+Alt+V)",
        command: "fumadocs.openPreview",
        arguments: [document.uri],
      }),
      new vscode.CodeLens(top, {
        title: "$(link-external) Open in Browser",
        tooltip: "Open the current Fumadocs preview in your browser",
        command: "fumadocs.openInBrowser",
      }),
    ];
  }
}
