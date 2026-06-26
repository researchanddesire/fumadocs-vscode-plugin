import * as vscode from "vscode";
import { findNamedContentRoot } from "../contentRoot";
import { isMarkdownEditor } from "../markdown";

export interface DocsToolsContext {
  enabled: boolean;
  contentRoot: string | null;
  filePath: string | null;
  fileName: string | null;
  reason: string;
}

export function getDocsToolsContext(): DocsToolsContext {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isMarkdownEditor(editor)) {
    return {
      enabled: false,
      contentRoot: null,
      filePath: null,
      fileName: null,
      reason: "Open a Markdown or MDX file to use docs tools.",
    };
  }

  const filePath = editor.document.uri.fsPath;
  const contentDirNames = vscode.workspace
    .getConfiguration("fumadocs")
    .get<string[]>("contentDirNames", ["content"]);
  const contentRoot = findNamedContentRoot(filePath, contentDirNames);

  if (!contentRoot) {
    return {
      enabled: false,
      contentRoot: null,
      filePath,
      fileName: editor.document.fileName,
      reason: "No content root found — place the file under a configured content directory.",
    };
  }

  return {
    enabled: true,
    contentRoot,
    filePath,
    fileName: editor.document.fileName,
    reason: "",
  };
}
