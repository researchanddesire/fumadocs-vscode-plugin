import * as vscode from "vscode";
import { isMarkdown, isMarkdownEditor } from "./markdown";

const PREVIEW_SHORTCUT =
  process.platform === "darwin" ? "Cmd+Alt+V" : "Ctrl+Alt+V";

/**
 * Draws a high-contrast call-to-action above line 1 in MD/MDX editors.
 * CodeLens on the same line provides the clickable action.
 */
export function registerEditorBanner(
  context: vscode.ExtensionContext,
): void {
  const bannerType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    before: {
      contentText: ` Fumadocs Preview — click Preview above or press ${PREVIEW_SHORTCUT} `,
      color: new vscode.ThemeColor("button.foreground"),
      backgroundColor: new vscode.ThemeColor("button.background"),
      border: "2px solid",
      borderColor: new vscode.ThemeColor("button.border"),
      fontWeight: "bold",
      margin: "0 0 10px 0",
    },
  });

  const apply = (editor: vscode.TextEditor | undefined): void => {
    for (const visible of vscode.window.visibleTextEditors) {
      if (visible !== editor) {
        visible.setDecorations(bannerType, []);
      }
    }

    if (!isMarkdownEditor(editor)) return;

    editor.setDecorations(bannerType, [new vscode.Range(0, 0, 0, 0)]);
  };

  context.subscriptions.push(
    bannerType,
    vscode.window.onDidChangeActiveTextEditor(apply),
    vscode.window.onDidChangeTextEditorVisibleRanges((event) =>
      apply(event.textEditor),
    ),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isMarkdown(doc)) apply(vscode.window.activeTextEditor);
    }),
    vscode.workspace.onDidCloseTextDocument(() =>
      apply(vscode.window.activeTextEditor),
    ),
  );

  apply(vscode.window.activeTextEditor);
}
