import * as vscode from "vscode";
import * as path from "path";
import { PreviewCodeLensProvider } from "./codelens";
import { ComponentEditCodeLensProvider } from "./componentEdit";
import { registerEditorActions } from "./editorActions";
import { registerEditorBanner } from "./editorBanner";
import { registerDocsToolsView } from "./docsTools/docsToolsView";
import { DevServerManager } from "./devServer";
import { PreviewPanel } from "./preview";
import { computeSlugPath, findContentRoot } from "./contentRoot";
import { isMarkdown } from "./markdown";

let manager: DevServerManager;
let output: vscode.OutputChannel;
let currentRoot: string | undefined;
let currentFile: string | undefined;
let scrollDebounce: ReturnType<typeof setTimeout> | undefined;
let reloadDebounce: ReturnType<typeof setTimeout> | undefined;
let liveDebounce: ReturnType<typeof setTimeout> | undefined;
let contentWatcher: vscode.FileSystemWatcher | undefined;
let watchedRoot: string | undefined;
/** Unsaved buffer contents (abs path -> text) pushed to the live preview. */
const overrides = new Map<string, string>();

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Fumadocs Preview");
  const webappDir = path.join(context.extensionPath, "webapp");
  manager = new DevServerManager(webappDir, output);

  const codeLensProvider = new PreviewCodeLensProvider();
  const componentLensProvider = new ComponentEditCodeLensProvider();
  let componentLensDebounce: ReturnType<typeof setTimeout> | undefined;
  const refreshComponentLenses = (): void => {
    if (componentLensDebounce) clearTimeout(componentLensDebounce);
    componentLensDebounce = setTimeout(() => componentLensProvider.refresh(), 250);
  };

  context.subscriptions.push(
    output,
    manager,
    vscode.languages.registerCodeLensProvider(
      [{ scheme: "file", pattern: "**/*.{md,mdx}" }],
      codeLensProvider,
    ),
    vscode.languages.registerCodeLensProvider(
      [{ scheme: "file", pattern: "**/*.{md,mdx}" }],
      componentLensProvider,
    ),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const doc = event.document;
      if (isMarkdown(doc)) refreshComponentLenses();
      // Mirror unsaved edits into the preview without waiting for a save.
      if (!PreviewPanel.exists || !currentRoot) return;
      if (!isOverridable(doc)) return;
      const file = doc.uri.fsPath;
      if (!file.startsWith(currentRoot)) return;
      overrides.set(path.resolve(file), doc.getText());
      scheduleLiveUpdate();
    }),
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
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (!PreviewPanel.exists) return;
      if (!isMarkdown(event.textEditor.document)) return;
      if (event.textEditor.document.uri.fsPath !== currentFile) return;
      syncScrollToCursor(event.textEditor);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      // Disk now matches the buffer — drop the override and render from disk.
      const file = path.resolve(doc.uri.fsPath);
      if (overrides.delete(file)) refreshOverrides();
      if (!PreviewPanel.exists || !currentRoot) return;
      if (doc.uri.fsPath.startsWith(currentRoot) || isMarkdown(doc)) {
        scheduleReload();
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      // A closed (possibly reverted) buffer should no longer override disk.
      const file = path.resolve(doc.uri.fsPath);
      if (!overrides.delete(file)) return;
      refreshOverrides();
      scheduleReload();
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isMarkdown(doc)) codeLensProvider.refresh();
    }),
  );

  registerEditorActions(context);
  registerEditorBanner(context);
  registerDocsToolsView(context);
}

export function deactivate(): void {
  manager?.dispose();
  contentWatcher?.dispose();
  contentWatcher = undefined;
  watchedRoot = undefined;
  if (scrollDebounce) clearTimeout(scrollDebounce);
  if (reloadDebounce) clearTimeout(reloadDebounce);
  if (liveDebounce) clearTimeout(liveDebounce);
}

/**
 * Watch the active content root for changes made on disk — including edits
 * from outside this VSCode window (other editors, scripts, git checkouts) —
 * and reload the preview. The runtime renderer reads content as data rather
 * than importing it, so Next.js never sees these files and won't hot-refresh;
 * this watcher is what makes external edits show up.
 */
function watchContentRoot(root: string): void {
  if (watchedRoot === root && contentWatcher) return;
  contentWatcher?.dispose();
  watchedRoot = root;
  const pattern = new vscode.RelativePattern(
    vscode.Uri.file(root),
    "**/*.{md,mdx,json,jsonc,png,jpg,jpeg,gif,svg,webp,avif}",
  );
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  watcher.onDidChange(() => scheduleReload());
  watcher.onDidCreate(() => scheduleReload());
  watcher.onDidDelete(() => scheduleReload());
  contentWatcher = watcher;
}

/**
 * Debounced preview reload, shared by the save handler and the filesystem
 * watcher so a single save (which fires both) only reloads once.
 */
function scheduleReload(): void {
  if (!PreviewPanel.exists) return;
  if (reloadDebounce) clearTimeout(reloadDebounce);
  reloadDebounce = setTimeout(() => {
    if (!PreviewPanel.exists) return;
    PreviewPanel.createOrShow().reload();
  }, 120);
}

/** Capture any already-open dirty buffers under `root` as overrides. */
function seedOverridesFromOpenDocs(root: string): void {
  for (const doc of vscode.workspace.textDocuments) {
    if (!doc.isDirty || !isOverridable(doc)) continue;
    const file = doc.uri.fsPath;
    if (!file.startsWith(root)) continue;
    overrides.set(path.resolve(file), doc.getText());
  }
}

/** Whether a document's unsaved content should be mirrored into the preview. */
function isOverridable(doc: vscode.TextDocument): boolean {
  if (isMarkdown(doc)) return true;
  const base = path.basename(doc.uri.fsPath);
  return base === "meta.json" || base === "meta.jsonc";
}

/** Push the current override set (scoped to the active root) to the renderer. */
function refreshOverrides(): void {
  const scoped: Record<string, string> = {};
  if (currentRoot) {
    for (const [file, content] of overrides) {
      if (file.startsWith(currentRoot)) scoped[file] = content;
    }
  }
  manager.setOverrides(scoped);
}

/**
 * Debounced live update: persist unsaved buffers, then soft-refresh. Writing
 * the state synchronously before the reload guarantees the renderer sees the
 * latest content on the refresh that follows.
 */
function scheduleLiveUpdate(): void {
  if (liveDebounce) clearTimeout(liveDebounce);
  liveDebounce = setTimeout(() => {
    refreshOverrides();
    if (PreviewPanel.exists) PreviewPanel.createOrShow().reload();
  }, 150);
}

/** Debounced sync of the editor's cursor line into the preview. */
function syncScrollToCursor(editor: vscode.TextEditor): void {
  if (scrollDebounce) clearTimeout(scrollDebounce);
  const line = editor.selection.active.line + 1;
  scrollDebounce = setTimeout(() => {
    if (!PreviewPanel.exists) return;
    PreviewPanel.createOrShow().scrollToLine(line);
  }, 80);
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

/** Stop the dev server and rebuild the preview for the current file. */
async function restartPreview(): Promise<void> {
  manager.stop();
  const target = currentFile ?? vscode.window.activeTextEditor?.document.uri.fsPath;
  if (!target) {
    void vscode.window.showWarningMessage(
      "Nothing to restart — open a Markdown or MDX file and start a preview first.",
    );
    return;
  }
  await updatePreviewFor(target);
}

async function updatePreviewFor(filePath: string): Promise<void> {
  const panel = PreviewPanel.createOrShow();
  panel.setRestartHandler(() => void restartPreview());
  const contentDirNames = vscode.workspace
    .getConfiguration("fumadocs")
    .get<string[]>("contentDirNames", ["content"]);

  const root = findContentRoot(filePath, contentDirNames);
  currentRoot = root;
  currentFile = filePath;
  watchContentRoot(root);
  seedOverridesFromOpenDocs(root);
  const slug = computeSlugPath(root, filePath);
  const route = slug === "/" ? "/" : slug;

  panel.showProgress(route, "Resolving content root…");
  try {
    const baseUrl = await manager.ensure(root, (phase) =>
      panel.showProgress(route, phase),
    );
    // Persist any already-dirty buffers now that the server root is set.
    refreshOverrides();
    panel.showProgress(route, "Loading page…");
    panel.navigate(baseUrl, slug, path.basename(filePath));
    // Seed the cursor line so the freshly loaded page scrolls to where the
    // user is; the webview replays this once the page signals it's ready.
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.fsPath === filePath) {
      panel.scrollToLine(editor.selection.active.line + 1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`[error] ${message}`);
    panel.showError(route, message, manager.getRecentLogs());
    void vscode.window.showErrorMessage(`Fumadocs Preview: ${message}`);
  }
}
