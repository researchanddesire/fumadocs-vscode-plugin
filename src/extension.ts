import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { PreviewCodeLensProvider } from "./codelens";
import { ComponentEditCodeLensProvider } from "./componentEdit";
import { MarkdownBlockEditCodeLensProvider } from "./markdownBlockEdit";
import { ImageEditCodeLensProvider } from "./imageEdit";
import { registerEditorActions } from "./editorActions";
import { registerDocsToolsView } from "./docsTools/docsToolsView";
import { DevServerManager, ToolchainAction, ToolchainError } from "./devServer";
import { PreviewPanel } from "./preview";
import { computeSlugPath, findContentRoot, findNamedContentRoot } from "./contentRoot";
import { isMarkdown } from "./markdown";
import { MetaEditorPanel } from "./metaEditor";
import { isMetaFile, MetaCodeLensProvider } from "./meta/metaCodeLens";
import {
  addPages,
  addRest,
  autoIncludeNewPage,
  MetaCodeActionProvider,
  refreshMetaDiagnostics,
  removeRefs,
} from "./meta/metaDiagnostics";
import { resolveMetaUri } from "./meta/metaWrite";
import { discoverFolderItems } from "./meta/metaModel";

let manager: DevServerManager;
let output: vscode.OutputChannel;
let currentRoot: string | undefined;
let currentFile: string | undefined;
let scrollDebounce: ReturnType<typeof setTimeout> | undefined;
let reloadDebounce: ReturnType<typeof setTimeout> | undefined;
let liveDebounce: ReturnType<typeof setTimeout> | undefined;
/** Whether the pending debounced reload should be a full (structural) reload. */
let pendingStructuralReload = false;
let contentWatcher: vscode.FileSystemWatcher | undefined;
let watchedRoot: string | undefined;
let metaDiagnostics: vscode.DiagnosticCollection;
let metaDiagDebounce: ReturnType<typeof setTimeout> | undefined;
/** Unsaved buffer contents (abs path -> text) pushed to the live preview. */
const overrides = new Map<string, string>();

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Fumadocs Preview");
  const webappDir = path.join(context.extensionPath, "webapp");
  manager = new DevServerManager(webappDir, output);

  const codeLensProvider = new PreviewCodeLensProvider();
  const componentLensProvider = new ComponentEditCodeLensProvider();
  const imageLensProvider = new ImageEditCodeLensProvider();
  const blockLensProvider = new MarkdownBlockEditCodeLensProvider();
  const metaLensProvider = new MetaCodeLensProvider();
  metaDiagnostics = vscode.languages.createDiagnosticCollection("fumadocs-meta");
  let componentLensDebounce: ReturnType<typeof setTimeout> | undefined;
  const refreshComponentLenses = (): void => {
    if (componentLensDebounce) clearTimeout(componentLensDebounce);
    componentLensDebounce = setTimeout(() => {
      componentLensProvider.refresh();
      imageLensProvider.refresh();
      blockLensProvider.refresh();
    }, 250);
  };

  const metaFileSelector: vscode.DocumentSelector = [
    { scheme: "file", pattern: "**/meta.json" },
    { scheme: "file", pattern: "**/meta.jsonc" },
  ];

  context.subscriptions.push(
    output,
    manager,
    metaDiagnostics,
    vscode.languages.registerCodeLensProvider(
      [{ scheme: "file", pattern: "**/*.{md,mdx}" }],
      codeLensProvider,
    ),
    vscode.languages.registerCodeLensProvider(
      [{ scheme: "file", pattern: "**/*.{md,mdx}" }],
      componentLensProvider,
    ),
    vscode.languages.registerCodeLensProvider(
      [{ scheme: "file", pattern: "**/*.{md,mdx}" }],
      imageLensProvider,
    ),
    vscode.languages.registerCodeLensProvider(
      [{ scheme: "file", pattern: "**/*.{md,mdx}" }],
      blockLensProvider,
    ),
    vscode.languages.registerCodeLensProvider(metaFileSelector, metaLensProvider),
    vscode.languages.registerCodeActionsProvider(
      metaFileSelector,
      new MetaCodeActionProvider(),
      { providedCodeActionKinds: MetaCodeActionProvider.providedKinds },
    ),
    vscode.commands.registerCommand("fumadocs.editMeta", (uri?: vscode.Uri) =>
      openMetaEditor(uri),
    ),
    vscode.commands.registerCommand("fumadocs.syncMeta", () =>
      syncActiveFolderMeta(),
    ),
    vscode.commands.registerCommand(
      "fumadocs.meta.addPages",
      (folderDir: string, slugs: string[]) => addPages(folderDir, slugs),
    ),
    vscode.commands.registerCommand(
      "fumadocs.meta.addRest",
      (folderDir: string) => addRest(folderDir),
    ),
    vscode.commands.registerCommand(
      "fumadocs.meta.removeRefs",
      (folderDir: string, refs: string[]) => removeRefs(folderDir, refs),
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
    vscode.commands.registerCommand("fumadocs.refreshPreview", () =>
      restartPreview(),
    ),
    vscode.commands.registerCommand("fumadocs.repairToolchain", () =>
      repairToolchain(),
    ),
    vscode.commands.registerCommand("fumadocs.copyWindowsScriptFix", () =>
      copyWindowsScriptFix(),
    ),
    vscode.commands.registerCommand("fumadocs.showToolchainDiagnostics", () =>
      showToolchainDiagnostics(),
    ),
    vscode.window.registerWebviewPanelSerializer("fumadocs.preview", {
      deserializeWebviewPanel(panel) {
        const restored = PreviewPanel.restore(panel);
        restored.setRestartHandler(() => void restartPreview());
        restored.setStartHandler(() => void openPreview());
        restored.setToolchainActionHandler((action) =>
          void handleToolchainAction(action),
        );
        return Promise.resolve();
      },
    }),
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
      if (isMarkdown(doc)) {
        codeLensProvider.refresh();
        imageLensProvider.refresh();
        componentLensProvider.refresh();
        blockLensProvider.refresh();
      }
      if (isMetaFile(doc.uri)) void refreshMetaDiagnostics(metaDiagnostics, doc.uri);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (isMetaFile(event.document.uri)) {
        scheduleMetaDiagnostics(event.document.uri);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (isMetaFile(doc.uri)) void refreshMetaDiagnostics(metaDiagnostics, doc.uri);
    }),
  );

  // Seed diagnostics for any meta files already open at startup.
  for (const doc of vscode.workspace.textDocuments) {
    if (isMetaFile(doc.uri)) void refreshMetaDiagnostics(metaDiagnostics, doc.uri);
  }

  registerEditorActions(context);
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
  if (metaDiagDebounce) clearTimeout(metaDiagDebounce);
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
  // Edits soft-refresh in place; create/delete are structural (a page or folder
  // appeared or disappeared) so they fully reload the iframe.
  watcher.onDidChange((uri) => {
    if (isMetaFile(uri)) scheduleMetaDiagnostics(uri);
    scheduleReload(false);
  });
  watcher.onDidCreate((uri) => {
    void handleContentCreated(uri);
    scheduleReload(true);
  });
  watcher.onDidDelete((uri) => {
    void handleContentDeleted(uri);
    scheduleReload(true);
  });
  contentWatcher = watcher;
}

/** Whether a uri is a markdown page on disk. */
function isPageFile(uri: vscode.Uri): boolean {
  const ext = path.extname(uri.fsPath).toLowerCase();
  return ext === ".md" || ext === ".mdx";
}

/** Refresh meta diagnostics for the meta file governing a given folder. */
function refreshFolderMeta(folderDir: string): void {
  void refreshMetaDiagnostics(metaDiagnostics, resolveMetaUri(folderDir));
}

/**
 * React to a new file on disk: auto-include new pages in the nearest meta
 * (when enabled) and refresh diagnostics.
 */
async function handleContentCreated(uri: vscode.Uri): Promise<void> {
  if (isMetaFile(uri)) {
    await refreshMetaDiagnostics(metaDiagnostics, uri);
    return;
  }
  if (!isPageFile(uri)) return;
  const autoInclude = vscode.workspace
    .getConfiguration("fumadocs")
    .get<boolean>("autoIncludePages", true);
  if (autoInclude) await autoIncludeNewPage(uri);
  refreshFolderMeta(path.dirname(uri.fsPath));
}

/** React to a deleted file: drop meta diagnostics or recheck for dangling refs. */
async function handleContentDeleted(uri: vscode.Uri): Promise<void> {
  if (isMetaFile(uri)) {
    metaDiagnostics.delete(uri);
    return;
  }
  if (isPageFile(uri)) refreshFolderMeta(path.dirname(uri.fsPath));
}

/** Debounced diagnostics refresh for a meta file (e.g. while typing). */
function scheduleMetaDiagnostics(uri: vscode.Uri): void {
  if (metaDiagDebounce) clearTimeout(metaDiagDebounce);
  metaDiagDebounce = setTimeout(() => {
    void refreshMetaDiagnostics(metaDiagnostics, uri);
  }, 250);
}

/** Resolve the folder a meta editor should target from a command argument. */
function resolveMetaFolder(uri?: vscode.Uri): string | undefined {
  if (uri) {
    try {
      const stat = fs.statSync(uri.fsPath);
      if (stat.isDirectory()) return uri.fsPath;
    } catch {
      // fall through to dirname handling
    }
    return path.dirname(uri.fsPath);
  }
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (active) return path.dirname(active);
  return undefined;
}

/** Open the visual meta editor for a folder (resolved from the argument). */
function openMetaEditor(uri?: vscode.Uri): void {
  const folder = resolveMetaFolder(uri);
  if (!folder) {
    void vscode.window.showWarningMessage(
      "Open a file inside a content folder, or right-click a folder, to edit its meta.json.",
    );
    return;
  }
  MetaEditorPanel.open(folder);
}

/** Add every missing page in the active file's folder to its meta.json. */
async function syncActiveFolderMeta(): Promise<void> {
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (!active) {
    void vscode.window.showWarningMessage(
      "Open a Markdown or MDX file to sync its folder's meta.json.",
    );
    return;
  }
  const contentDirNames = vscode.workspace
    .getConfiguration("fumadocs")
    .get<string[]>("contentDirNames", ["content"]);
  // Only act inside a real content root to avoid touching unrelated folders.
  if (!findNamedContentRoot(active, contentDirNames)) {
    void vscode.window.showWarningMessage(
      "This file isn't inside a configured content directory.",
    );
    return;
  }
  const folderDir = path.dirname(active);
  const slugs = discoverFolderItems(folderDir).map((e) => e.slug);
  await addPages(folderDir, slugs);
  refreshFolderMeta(folderDir);
}

/**
 * Debounced preview reload, shared by the save handler and the filesystem
 * watcher so a single save (which fires both) only reloads once. When
 * `structural` is true (pages/folders added or removed) the iframe is fully
 * reloaded; otherwise a soft in-place refresh preserves scroll position.
 */
function scheduleReload(structural = false): void {
  if (!PreviewPanel.exists) return;
  if (structural) pendingStructuralReload = true;
  if (reloadDebounce) clearTimeout(reloadDebounce);
  reloadDebounce = setTimeout(() => {
    if (!PreviewPanel.exists) {
      pendingStructuralReload = false;
      return;
    }
    const panel = PreviewPanel.createOrShow();
    if (pendingStructuralReload) panel.reloadHard();
    else panel.reload();
    pendingStructuralReload = false;
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

async function repairToolchain(): Promise<void> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Fumadocs Preview: fixing image support…",
        cancellable: false,
      },
      (_progress) =>
        manager.repairSharp((phase) => {
          _progress.report({ message: phase });
        }),
    );
    void vscode.window.showInformationMessage(
      "Fumadocs Preview image support was repaired.",
    );
    await restartPreview();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`[repair] ${message}`);
    void vscode.window.showErrorMessage(
      `Fumadocs Preview repair failed: ${message}`,
    );
  }
}

async function copyWindowsScriptFix(): Promise<void> {
  await vscode.env.clipboard.writeText(manager.windowsExecutionPolicyCommands());
  void vscode.window.showInformationMessage(
    "Copied the Windows PowerShell script fix commands.",
  );
}

async function showToolchainDiagnostics(): Promise<void> {
  const diagnostics = await manager.getToolchainDiagnostics();
  output.appendLine("");
  output.appendLine("========== Toolchain diagnostics ==========");
  output.appendLine(diagnostics);
  output.appendLine("==========================================");
  output.show(true);
}

async function handleToolchainAction(action: string): Promise<void> {
  switch (action as ToolchainAction) {
    case "repairSharp":
      await repairToolchain();
      break;
    case "copyExecutionPolicyCommands":
      await copyWindowsScriptFix();
      break;
    case "showDiagnostics":
      await showToolchainDiagnostics();
      break;
    case "retryPreview":
      await restartPreview();
      break;
    case "openSharpHelp":
      void vscode.env.openExternal(vscode.Uri.parse("https://sharp.pixelplumbing.com/install"));
      break;
    default:
      output.appendLine(`[toolchain] unknown action: ${action}`);
  }
}

async function updatePreviewFor(filePath: string): Promise<void> {
  const panel = PreviewPanel.createOrShow();
  panel.setRestartHandler(() => void restartPreview());
  panel.setStartHandler(() => void openPreview());
  panel.setToolchainActionHandler((action) => void handleToolchainAction(action));
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
    const help =
      err instanceof ToolchainError && err.helpUrl && err.helpLabel
        ? { url: err.helpUrl, label: err.helpLabel }
        : undefined;
    const actions = err instanceof ToolchainError ? err.actions : undefined;
    panel.showError(route, message, manager.getRecentLogs(), help, actions);
    void vscode.window.showErrorMessage(`Fumadocs Preview: ${message}`);
  }
}
