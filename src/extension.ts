import * as vscode from "vscode";
import { insertComponent, newDocPage } from "./commands";
import { completionProvider } from "./completion";
import { hoverProvider } from "./hover";
import { refreshDiagnostics } from "./diagnostics";
import { openPreview } from "./preview";
import { convertAll } from "./codeActions";
import { insertImage } from "./image";

const SELECTORS: vscode.DocumentSelector = [
  { language: "mdx", scheme: "file" },
  { language: "markdown", scheme: "file" },
];

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "fumadocs.insertComponent",
      insertComponent,
    ),
    vscode.commands.registerCommand("fumadocs.newDocPage", newDocPage),
    vscode.commands.registerCommand("fumadocs.openPreview", () =>
      openPreview(context.extensionUri),
    ),
    vscode.commands.registerCommand("fumadocs.insertImage", insertImage),
    vscode.commands.registerCommand("fumadocs.convertAll", convertAll),
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      SELECTORS,
      completionProvider,
      "<",
      " ",
    ),
    vscode.languages.registerHoverProvider(SELECTORS, hoverProvider),
  );

  const diagnostics = vscode.languages.createDiagnosticCollection("fumadocs");
  context.subscriptions.push(diagnostics);

  const runDiagnostics = (document: vscode.TextDocument): void =>
    refreshDiagnostics(document, diagnostics);

  if (vscode.window.activeTextEditor) {
    runDiagnostics(vscode.window.activeTextEditor.document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(runDiagnostics),
    vscode.workspace.onDidChangeTextDocument((event) =>
      runDiagnostics(event.document),
    ),
    vscode.workspace.onDidCloseTextDocument((document) =>
      diagnostics.delete(document.uri),
    ),
  );

  for (const document of vscode.workspace.textDocuments) {
    runDiagnostics(document);
  }
}

export function deactivate(): void {
  // Nothing to clean up; subscriptions are disposed by VSCode.
}
