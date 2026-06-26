import * as path from "path";
import * as vscode from "vscode";

/** True when a uri points at a Fumadocs meta file. */
export function isMetaFile(uri: vscode.Uri): boolean {
  const base = path.basename(uri.fsPath).toLowerCase();
  return base === "meta.json" || base === "meta.jsonc";
}

/**
 * Adds an "Edit in Fumadocs" CodeLens at the top of every `meta.json` /
 * `meta.jsonc` file, opening the visual meta editor for that folder.
 */
export class MetaCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeCodeLensesEmitter =
    new vscode.EventEmitter<void>();

  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  refresh(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isMetaFile(document.uri)) return [];
    const top = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(top, {
        title: "$(edit) Edit in Fumadocs",
        tooltip: "Open the visual meta.json editor for this folder",
        command: "fumadocs.editMeta",
        arguments: [document.uri],
      }),
    ];
  }
}
