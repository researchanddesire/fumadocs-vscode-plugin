import * as vscode from "vscode";
import * as path from "path";
import { PreviewCodeLensProvider } from "./codelens";
import { registerEditorActions } from "./editorActions";
import { registerEditorBanner } from "./editorBanner";
import { DevServerManager } from "./devServer";
import { PreviewPanel } from "./preview";
import { computeSlugPath, findContentRoot } from "./contentRoot";
import { isMarkdown } from "./markdown";

let manager: DevServerManager;
let output: vscode.OutputChannel;
let currentRoot: string | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Fumadocs Preview");
  const webappDir = path.join(context.extensionPath, "webapp");
  manager = new DevServerManager(webappDir, output);

  const codeLensProvider = new PreviewCodeLensProvider();

  context.subscriptions.push(
    output,
    manager,
    vscode.languages.registerCodeLensProvider(
      [{ scheme: "file", pattern: "**/*.{md,mdx}" }],
      codeLensProvider,
    ),
    vscode.commands.registerCommand(
      "fumadocs.openPreview",
      (uri?: vscode.Uri) => openPreview(uri),
    ),
    vscode.commands.registerCommand("fumadocs.openInBrowser", () =>
      openPreviewInBrowser(),
    ),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!PreviewPanel.exists || !editor) return;
      if (!isMarkdown(editor.document)) return;
      void updatePreviewFor(editor.document.uri.fsPath);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!PreviewPanel.exists || !currentRoot) return;
      const file = doc.uri.fsPath;
      if (file.startsWith(currentRoot) || isMarkdown(doc)) {
        PreviewPanel.createOrShow().reload();
      }
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isMarkdown(doc)) codeLensProvider.refresh();
    }),
  );

  registerEditorActions(context);
  registerEditorBanner(context);
}

export function deactivate(): void {
  manager?.dispose();
}

async function openPreview(uri?: vscode.Uri): Promise<void> {
  const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!targetUri) {
    void vscode.window.showWarningMessage(
      "Open a Markdown or MDX file to preview it with Fumadocs.",
    );
    return;
  }

  const doc = await vscode.workspace.openTextDocument(targetUri);
  if (!isMarkdown(doc)) {
    void vscode.window.showWarningMessage(
      "Open a Markdown or MDX file to preview it with Fumadocs.",
    );
    return;
  }

  PreviewPanel.createOrShow();
  await updatePreviewFor(targetUri.fsPath);
}

function openPreviewInBrowser(): void {
  const url = PreviewPanel.currentUrl;
  if (!url) {
    void vscode.window.showWarningMessage(
      "Nothing to open yet — start a preview first.",
    );
    return;
  }
  void vscode.env.openExternal(vscode.Uri.parse(url));
}

async function updatePreviewFor(filePath: string): Promise<void> {
  const panel = PreviewPanel.createOrShow();
  const contentDirNames = vscode.workspace
    .getConfiguration("fumadocs")
    .get<string[]>("contentDirNames", ["content"]);

  const root = findContentRoot(filePath, contentDirNames);
  currentRoot = root;
  const slug = computeSlugPath(root, filePath);
  const route = slug === "/" ? "/" : slug;

  panel.showProgress(route, "Resolving content root…");
  try {
    const baseUrl = await manager.ensure(root, (phase) =>
      panel.showProgress(route, phase),
    );
    panel.showProgress(route, "Loading page…");
    panel.navigate(baseUrl, slug, path.basename(filePath));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`[error] ${message}`);
    panel.showError(route, message, manager.getRecentLogs());
    void vscode.window.showErrorMessage(`Fumadocs Preview: ${message}`);
  }
}
