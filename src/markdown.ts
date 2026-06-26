import * as path from "path";
import * as vscode from "vscode";

const MARKDOWN_LANGS = new Set(["mdx", "markdown"]);
const MARKDOWN_EXTS = new Set([".md", ".mdx"]);

/** Document selectors that match MD/MDX files regardless of assigned language mode. */
export const MARKDOWN_DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { language: "mdx" },
  { language: "markdown" },
  { scheme: "file", pattern: "**/*.md" },
  { scheme: "file", pattern: "**/*.mdx" },
];

export function isMarkdown(doc: vscode.TextDocument): boolean {
  if (MARKDOWN_LANGS.has(doc.languageId)) return true;
  return MARKDOWN_EXTS.has(path.extname(doc.uri.fsPath).toLowerCase());
}

export function isMarkdownEditor(
  editor: vscode.TextEditor | undefined,
): editor is vscode.TextEditor {
  return editor !== undefined && isMarkdown(editor.document);
}
