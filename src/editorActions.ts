import * as vscode from "vscode";
import {
  isMarkdown,
  isMarkdownEditor,
  MARKDOWN_DOCUMENT_SELECTOR,
} from "./markdown";

/**
 * Surfaces Preview in editor chrome and the status bar — works even when
 * CodeLens is disabled or too faint to notice.
 */
export function registerEditorActions(
  context: vscode.ExtensionContext,
): void {
  const languageStatus = vscode.languages.createLanguageStatusItem(
    "fumadocs.preview",
    MARKDOWN_DOCUMENT_SELECTOR,
  );
  languageStatus.name = "Fumadocs";
  languageStatus.text = "$(open-preview) Preview";
  languageStatus.detail = "Open side preview";
  languageStatus.command = {
    command: "fumadocs.openPreview",
    title: "Preview",
  };

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    1,
  );
  statusBar.command = "fumadocs.openPreview";
  statusBar.text = "$(open-preview) Fumadocs Preview";
  statusBar.tooltip = "Open Fumadocs preview to the side (Cmd+Alt+V)";
  statusBar.backgroundColor = new vscode.ThemeColor(
    "statusBarItem.prominentBackground",
  );
  statusBar.color = new vscode.ThemeColor(
    "statusBarItem.prominentForeground",
  );

  const syncVisibility = (editor: vscode.TextEditor | undefined): void => {
    if (isMarkdownEditor(editor)) {
      statusBar.show();
      return;
    }
    statusBar.hide();
  };

  context.subscriptions.push(
    languageStatus,
    statusBar,
    vscode.window.onDidChangeActiveTextEditor(syncVisibility),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isMarkdown(doc)) syncVisibility(vscode.window.activeTextEditor);
    }),
  );

  syncVisibility(vscode.window.activeTextEditor);
}
