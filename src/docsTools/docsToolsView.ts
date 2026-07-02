import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  FUMADOCS_COMPONENT_MIME,
  FUMADOCS_COMPONENTS,
  getComponent,
} from "./componentSnippets";
import {
  absImagePath,
  buildImageMarkup,
  fetchRemoteImage,
  ImageInsertPayload,
  pickImageFile,
  readLocalImageForSrc,
  resolveImageSrc,
} from "./imageDialog";
import {
  ImageEditSettings,
  loadOriginal,
  storeOriginal,
} from "./imageCache";
import { insertBlockBelowCursor } from "./insertAtCursor";
import { prepareMdxBlock } from "./insertPlan";
import { isMarkdownEditor } from "../markdown";
import { getDocsToolsContext } from "./state";
import { findImages } from "../imageEdit";
import { ComponentDropProvider } from "./componentDrop";

/** The component block currently being built/edited live in the document. */
interface ComponentSession {
  uri: vscode.Uri;
  /** Current span of the block in the document, kept in sync on every apply. */
  range: vscode.Range;
  mode: "edit" | "insert";
  /** Original block text for edit-mode revert; null for insert mode. */
  originalText: string | null;
}

/** The existing image tag being edited live in the document. */
interface ImageSession {
  uri: vscode.Uri;
  range: vscode.Range;
  src: string;
  /** Whether the source was a JSX `<img>` tag (vs Markdown `![]()`). */
  useImgTag: boolean;
}

/** Messages posted from the sidebar webview to the extension. */
interface SidebarMessage {
  type?: string;
  id?: string;
  text?: string;
  mode?: string;
  url?: string;
  payload?: ImageInsertPayload;
}

export class DocsToolsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "fumadocs.docsTools";

  private view: vscode.WebviewView | undefined;
  private pendingBuilderId: string | undefined;
  private pendingEdit: { id: string; text: string } | undefined;
  /** Pending image-builder open message, flushed once the view is ready. */
  private pendingImage:
    | { mode: "insert" }
    | {
        mode: "edit";
        src: string;
        alt: string;
        kind: "img" | "md";
        dataUrl: string | null;
        width: string | null;
        height: string | null;
        /** Settings from the cached original, replayed in the builder. */
        cache: ImageEditSettings | null;
      }
    | undefined;
  /** Live-edit session for the component currently open in the builder. */
  private session: ComponentSession | undefined;
  /** Editor captured when an insert-mode builder opens (before the block exists). */
  private pendingInsertEditor: vscode.TextEditor | undefined;
  /** Editor captured when the image builder opens in insert mode. */
  private pendingImageEditor: vscode.TextEditor | undefined;
  /** Active edit-mode image session (existing tag being replaced). */
  private imageSession: ImageSession | undefined;
  /** Serializes document edits so debounced applies never interleave. */
  private queue: Promise<void> = Promise.resolve();
  /** Serializes image applies so repeated crop/slider releases stay ordered. */
  private imageQueue: Promise<void> = Promise.resolve();

  constructor(private readonly extensionPath: string) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };
    webviewView.webview.html = sidebarHtml(this.extensionPath);

    webviewView.webview.onDidReceiveMessage((msg: SidebarMessage) =>
      this.handleMessage(msg),
    );

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.pushState();
        this.flushBuilder();
      }
    });

    this.pushState();
    this.flushBuilder();
  }

  private handleMessage(msg: SidebarMessage): void {
    if (this.handleImageMessage(msg)) return;
    switch (msg.type) {
      case "addImage":
        this.openImageBuilder();
        break;
      case "editMeta":
        void vscode.commands.executeCommand("fumadocs.editMeta");
        break;
      case "insertComponent":
        if (msg.id) void insertComponent(msg.id);
        break;
      case "liveApply":
        if (typeof msg.text === "string") {
          this.enqueueLiveApply(msg.text, msg.mode === "edit" ? "edit" : "insert");
        }
        break;
      case "cancelEdit":
        this.enqueueCancel();
        break;
      case "finishEdit":
        this.enqueueFinish();
        break;
      case "refresh":
        this.pushState();
        this.flushBuilder();
        break;
    }
  }

  /** Handle image-builder messages; returns true when the message was handled. */
  private handleImageMessage(msg: SidebarMessage): boolean {
    switch (msg.type) {
      case "imagePickFile":
        void this.handleImagePick();
        return true;
      case "imageFetchUrl":
        if (msg.url) void this.handleImageFetch(msg.url);
        return true;
      case "imageInsert":
        if (msg.payload) void this.handleImageInsert(msg.payload);
        return true;
      case "imageLiveApply":
        if (msg.payload) this.enqueueImageLiveApply(msg.payload);
        return true;
      case "imageCancel":
        this.clearImageSession();
        return true;
      default:
        return false;
    }
  }

  refresh(): void {
    this.pushState();
  }

  /** Reveal the sidebar and open the builder overlay for `id` (insert mode). */
  openBuilder(id: string): void {
    this.pendingBuilderId = id;
    // Capture the editor now: the block is inserted into it on the first apply.
    this.pendingInsertEditor = vscode.window.activeTextEditor;
    this.session = undefined;
    void vscode.commands.executeCommand("fumadocs.docsTools.focus");
    this.flushBuilder();
  }

  /**
   * Reveal the sidebar and open the builder pre-filled with an existing
   * component's source. Edits are applied live to `range` in `uri`; Cancel
   * reverts to the original text.
   */
  openBuilderForEdit(
    uri: vscode.Uri,
    id: string,
    range: vscode.Range,
    text: string,
  ): void {
    this.session = { uri, range, mode: "edit", originalText: text };
    this.pendingInsertEditor = undefined;
    this.pendingEdit = { id, text };
    void vscode.commands.executeCommand("fumadocs.docsTools.focus");
    this.flushBuilder();
  }

  /** Reveal the sidebar and open the image builder to insert a new image. */
  openImageBuilder(): void {
    const ctx = getDocsToolsContext();
    if (!ctx.enabled) {
      void vscode.window.showWarningMessage(
        ctx.reason || "Docs tools are not available.",
      );
      return;
    }
    // Capture the editor now so the image lands where the cursor is, even after
    // the user interacts with the sidebar.
    this.pendingImageEditor = vscode.window.activeTextEditor;
    this.imageSession = undefined;
    this.pendingImage = { mode: "insert" };
    void vscode.commands.executeCommand("fumadocs.docsTools.focus");
    this.flushBuilder();
  }

  /**
   * Reveal the sidebar and open the image builder pre-filled with an existing
   * image. Saving replaces `range` in `uri`; the current bytes are loaded for
   * re-cropping when the source is a local file.
   */
  openImageBuilderForEdit(
    uri: vscode.Uri,
    range: vscode.Range,
    src: string,
    alt: string,
    kind: "img" | "md",
    width?: string,
    height?: string,
  ): void {
    // Prefer the cached pristine original (so the crop can be reverted and
    // quality changed without compounding loss); fall back to the on-disk file.
    const abs = absImagePath(src, uri.fsPath);
    const cached = abs ? loadOriginal(abs) : null;
    const loaded = cached ? null : readLocalImageForSrc(src, uri.fsPath);
    this.imageSession = { uri, range, src, useImgTag: kind === "img" };
    this.pendingImageEditor = undefined;
    this.pendingImage = {
      mode: "edit",
      src,
      alt,
      kind,
      dataUrl: cached?.dataUrl ?? loaded?.dataUrl ?? null,
      width: width ?? null,
      height: height ?? null,
      cache: cached?.settings ?? null,
    };
    void vscode.commands.executeCommand("fumadocs.docsTools.focus");
    this.flushBuilder();
  }

  private clearImageSession(): void {
    this.imageSession = undefined;
    this.pendingImageEditor = undefined;
  }

  private async handleImagePick(): Promise<void> {
    const loaded = await pickImageFile();
    if (!loaded) return;
    void this.view?.webview.postMessage({ type: "imageLoaded", ...loaded });
  }

  private async handleImageFetch(url: string): Promise<void> {
    try {
      const loaded = await fetchRemoteImage(url);
      void this.view?.webview.postMessage({ type: "imageLoaded", ...loaded });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void this.view?.webview.postMessage({ type: "imageError", message });
    }
  }

  private async handleImageInsert(payload: ImageInsertPayload): Promise<void> {
    try {
      if (this.imageSession) {
        await this.applyImageEdit(payload, this.imageSession);
      } else {
        await this.applyImageInsert(payload);
      }
      this.clearImageSession();
      void this.view?.webview.postMessage({ type: "imageDone" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void this.view?.webview.postMessage({ type: "imageError", message });
    }
  }

  private enqueueImageLiveApply(payload: ImageInsertPayload): void {
    this.imageQueue = this.imageQueue
      .then(() => this.handleImageLiveApply(payload))
      .catch(() => undefined);
  }

  private async handleImageLiveApply(payload: ImageInsertPayload): Promise<void> {
    try {
      if (!this.imageSession) {
        throw new Error("No image edit is active.");
      }
      const src = await this.applyImageEdit(payload, this.imageSession, false);
      void this.view?.webview.postMessage({ type: "imageApplied", src });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void this.view?.webview.postMessage({ type: "imageError", message });
    }
  }

  private async applyImageInsert(payload: ImageInsertPayload): Promise<void> {
    const editor = this.pendingImageEditor ?? vscode.window.activeTextEditor;
    if (!isMarkdownEditor(editor)) {
      throw new Error("Open a Markdown or MDX file to insert an image.");
    }
    const src = resolveImageSrc(payload, editor.document.uri.fsPath);
    if (!src) throw new Error("No image source provided.");
    const useImgTag =
      path.extname(editor.document.uri.fsPath).toLowerCase() === ".mdx";
    const markup = buildImageMarkup(
      src,
      payload.alt,
      useImgTag,
      payload.width,
      payload.height,
    );
    this.cacheOriginal(payload, src, editor.document.uri.fsPath);
    await insertBlockBelowCursor(markup, editor);
    void vscode.window.showInformationMessage(`Image inserted: ${src}`);
  }

  private async applyImageEdit(
    payload: ImageInsertPayload,
    session: ImageSession,
    notify = true,
  ): Promise<string> {
    const src = resolveImageSrc(payload, session.uri.fsPath);
    if (!src) throw new Error("No image source provided.");
    const markup = buildImageMarkup(
      src,
      payload.alt,
      session.useImgTag,
      payload.width,
      payload.height,
    );
    this.cacheOriginal(payload, src, session.uri.fsPath);
    const range = await resolveImageEditRange(session);
    const next = await replaceRange(session.uri, range, markup);
    if (next) {
      session.range = next;
      session.src = src;
    }
    if (notify) void vscode.window.showInformationMessage(`Image updated: ${src}`);
    return src;
  }

  /** Cache the pristine source + settings for a saved file, for later editing. */
  private cacheOriginal(
    payload: ImageInsertPayload,
    src: string,
    mdxFilePath: string,
  ): void {
    if (payload.mode !== "file" || !payload.originalDataUrl) return;
    const abs = absImagePath(src, mdxFilePath);
    if (!abs) return;
    const settings: ImageEditSettings = {
      crop: payload.crop,
      maxWidth: payload.maxWidth,
      quality: payload.quality,
      format: payload.format,
    };
    storeOriginal(abs, payload.originalDataUrl, settings);
  }

  private flushBuilder(): void {
    if (!this.view) return;
    if (this.pendingBuilderId) {
      void this.view.webview.postMessage({
        type: "openBuilder",
        id: this.pendingBuilderId,
      });
      this.pendingBuilderId = undefined;
    }
    if (this.pendingEdit) {
      void this.view.webview.postMessage({
        type: "editBuilder",
        id: this.pendingEdit.id,
        text: this.pendingEdit.text,
      });
      this.pendingEdit = undefined;
    }
    if (this.pendingImage) {
      void this.view.webview.postMessage({
        type: this.pendingImage.mode === "edit" ? "editImage" : "openImage",
        data: this.pendingImage,
      });
      this.pendingImage = undefined;
    }
  }

  /** Queue a live apply of the rebuilt markup (debounced sender on the UI side). */
  private enqueueLiveApply(text: string, mode: "edit" | "insert"): void {
    this.queue = this.queue
      .then(() => this.doLiveApply(text, mode))
      .catch(() => undefined);
  }

  /** Queue a revert: restore the original text (edit) or remove the block (insert). */
  private enqueueCancel(): void {
    this.queue = this.queue.then(() => this.doCancel()).catch(() => undefined);
  }

  /** Queue finalization: keep the current content and end the session. */
  private enqueueFinish(): void {
    this.queue = this.queue
      .then(() => {
        this.session = undefined;
        this.pendingInsertEditor = undefined;
      })
      .catch(() => undefined);
  }

  /**
   * Apply the rebuilt component to the document. In insert mode the first apply
   * drops the block at the cursor and starts the session; later applies (and all
   * edit-mode applies) replace the tracked range in place.
   */
  private async doLiveApply(
    text: string,
    mode: "edit" | "insert",
  ): Promise<void> {
    if (mode === "insert" && !this.session) {
      const editor = this.pendingInsertEditor ?? vscode.window.activeTextEditor;
      if (!editor) return;
      const inserted = await insertBlockBelowCursor(text, editor);
      if (!inserted) return;
      this.session = {
        uri: editor.document.uri,
        range: inserted.range,
        mode: "insert",
        originalText: null,
      };
      this.pendingInsertEditor = undefined;
      return;
    }

    if (!this.session) return;
    const next = await replaceRange(this.session.uri, this.session.range, text);
    if (next) this.session.range = next;
  }

  private async doCancel(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    this.pendingInsertEditor = undefined;
    if (!session) return;

    if (session.mode === "edit" && session.originalText != null) {
      await replaceRange(session.uri, session.range, session.originalText, {
        prepare: false,
      });
    } else if (session.mode === "insert") {
      await removeBlock(session.uri, session.range);
    }
  }

  private pushState(): void {
    const ctx = getDocsToolsContext();
    void vscode.commands.executeCommand(
      "setContext",
      "fumadocs.docsToolsEnabled",
      ctx.enabled,
    );
    void this.view?.webview.postMessage({
      type: "state",
      context: ctx,
      components: FUMADOCS_COMPONENTS.map((c) => ({
        id: c.id,
        label: c.label,
        description: c.description,
        configurable: c.configurable,
        snippet: c.snippet,
      })),
    });
  }
}

async function insertComponent(id: string): Promise<void> {
  const ctx = getDocsToolsContext();
  if (!ctx.enabled) {
    void vscode.window.showWarningMessage(ctx.reason || "Docs tools are not available.");
    return;
  }

  const component = getComponent(id);
  if (!component?.snippet) return;

  await insertBlockBelowCursor(component.snippet);
}

/**
 * Replace `range` in `uri` with `text` and return the new range the text
 * occupies, so a live session can keep editing the same block.
 */
async function replaceRange(
  uri: vscode.Uri,
  range: vscode.Range,
  text: string,
  options: { prepare?: boolean } = {},
): Promise<vscode.Range | null> {
  const nextText = options.prepare === false ? text : prepareMdxBlock(text);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, range, nextText);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) return null;

  const lines = nextText.split("\n");
  const endLine = range.start.line + lines.length - 1;
  const endChar =
    lines.length === 1
      ? range.start.character + lines[0].length
      : (lines.at(-1) ?? "").length;
  return new vscode.Range(range.start, new vscode.Position(endLine, endChar));
}

async function resolveImageEditRange(
  session: ImageSession,
): Promise<vscode.Range> {
  const doc = await vscode.workspace.openTextDocument(session.uri);
  const currentText =
    session.range.end.line < doc.lineCount ? doc.getText(session.range) : "";
  if (currentText.includes(session.src)) return session.range;

  const matches = findImages(doc).filter((hit) => hit.src === session.src);
  if (matches.length === 0) return session.range;

  return matches.reduce((nearest, hit) => {
    const nearestDistance = Math.abs(
      nearest.range.start.line - session.range.start.line,
    );
    const hitDistance = Math.abs(hit.range.start.line - session.range.start.line);
    return hitDistance < nearestDistance ? hit : nearest;
  }).range;
}

/** Delete a block (plus one adjacent blank line) — used to undo a cancelled insert. */
async function removeBlock(
  uri: vscode.Uri,
  range: vscode.Range,
): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  let startLine = range.start.line;
  const endLine = Math.min(range.end.line, doc.lineCount - 1);
  if (startLine > 0 && doc.lineAt(startLine - 1).text.trim() === "") startLine--;
  const start = new vscode.Position(startLine, 0);
  const end =
    endLine + 1 < doc.lineCount
      ? new vscode.Position(endLine + 1, 0)
      : doc.lineAt(endLine).range.end;
  const edit = new vscode.WorkspaceEdit();
  edit.delete(uri, new vscode.Range(start, end));
  await vscode.workspace.applyEdit(edit);
}

interface ComponentQuickPickItem extends vscode.QuickPickItem {
  id: string;
  configurable: boolean;
}

async function addComponentViaQuickPick(
  provider: DocsToolsViewProvider,
): Promise<void> {
  const ctx = getDocsToolsContext();
  if (!ctx.enabled) {
    void vscode.window.showWarningMessage(ctx.reason || "Docs tools are not available.");
    return;
  }

  const items: ComponentQuickPickItem[] = FUMADOCS_COMPONENTS.map((c) => ({
    label: c.label,
    detail: c.description,
    id: c.id,
    configurable: c.configurable,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Insert a Fumadocs component",
    matchOnDetail: true,
  });
  if (!pick) return;

  if (pick.configurable) {
    provider.openBuilder(pick.id);
    return;
  }
  await insertComponent(pick.id);
}

/** Open the builder for configurable components, or insert the snippet directly. */
function insertOrConfigure(
  provider: DocsToolsViewProvider,
  id: string,
  configurable: boolean,
): void {
  const ctx = getDocsToolsContext();
  if (!ctx.enabled) {
    void vscode.window.showWarningMessage(
      ctx.reason || "Docs tools are not available.",
    );
    return;
  }
  if (configurable) {
    provider.openBuilder(id);
    return;
  }
  void insertComponent(id);
}

export function registerDocsToolsView(
  context: vscode.ExtensionContext,
): DocsToolsViewProvider {
  const provider = new DocsToolsViewProvider(context.extensionPath);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DocsToolsViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand("fumadocs.docsTools.addImage", () =>
      provider.openImageBuilder(),
    ),
    vscode.languages.registerDocumentDropEditProvider(
      [{ scheme: "file", pattern: "**/*.{md,mdx}" }],
      new ComponentDropProvider(),
      {
        dropMimeTypes: [FUMADOCS_COMPONENT_MIME],
        providedDropEditKinds: [vscode.DocumentDropOrPasteEditKind.Text],
      },
    ),
    vscode.commands.registerCommand(
      "fumadocs.editImage",
      (
        uri: vscode.Uri,
        range: vscode.Range,
        src: string,
        alt: string,
        kind: "img" | "md",
        width?: string,
        height?: string,
      ) =>
        provider.openImageBuilderForEdit(
          uri,
          range,
          src,
          alt,
          kind,
          width,
          height,
        ),
    ),
    vscode.commands.registerCommand("fumadocs.docsTools.addComponent", () =>
      addComponentViaQuickPick(provider),
    ),
    vscode.commands.registerCommand(
      "fumadocs.docsTools.insertComponent",
      (id: string) => insertComponent(id),
    ),
    vscode.commands.registerCommand(
      "fumadocs.editComponent",
      async (uri: vscode.Uri, id: string, range: vscode.Range) => {
        const doc = await vscode.workspace.openTextDocument(uri);
        provider.openBuilderForEdit(uri, id, range, doc.getText(range));
      },
    ),
    ...FUMADOCS_COMPONENTS.map((c) =>
      vscode.commands.registerCommand(`fumadocs.insertComponent.${c.id}`, () =>
        insertOrConfigure(provider, c.id, c.configurable),
      ),
    ),
    vscode.commands.registerCommand("fumadocs.docsTools.refresh", () =>
      provider.refresh(),
    ),
    vscode.window.onDidChangeActiveTextEditor(() => provider.refresh()),
    vscode.window.onDidChangeTextEditorSelection(() => provider.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("fumadocs.contentDirNames")) {
        provider.refresh();
      }
    }),
    vscode.workspace.onDidOpenTextDocument(() => provider.refresh()),
  );

  // Seed the docsToolsEnabled context key so menu gating works before the
  // sidebar view is ever opened.
  provider.refresh();

  return provider;
}

/** Read a vendored asset from `media/vendor/`, returning "" if it's missing. */
function readVendorAsset(extensionPath: string, file: string): string {
  try {
    return fs.readFileSync(
      path.join(extensionPath, "media", "vendor", file),
      "utf8",
    );
  } catch {
    return "";
  }
}

function sidebarHtml(extensionPath: string): string {
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    "img-src data: blob: https: http:",
    "connect-src https: http:",
  ].join("; ");

  const cropperCss = readVendorAsset(extensionPath, "cropper.min.css");
  const cropperJs = readVendorAsset(extensionPath, "cropper.min.js");

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>${cropperCss}</style>
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
  }
  body { position: relative; }
  .root {
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .section-title {
    margin: 0 0 8px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-descriptionForeground));
  }
  .status {
    margin: 0;
    font-size: 12px;
    line-height: 1.45;
    color: var(--vscode-descriptionForeground);
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.12));
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
  }
  .status.active {
    color: var(--vscode-foreground);
    border-color: var(--vscode-focusBorder, rgba(128,128,128,0.35));
  }
  .status strong {
    display: block;
    font-size: 11px;
    margin-bottom: 2px;
    color: var(--vscode-descriptionForeground);
    font-weight: 600;
  }
  .ctx-name {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
    line-height: 1.25;
    color: var(--vscode-foreground);
    word-break: break-word;
  }
  .ctx-file {
    margin: 2px 0 0;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    word-break: break-word;
  }
  .tool-btn {
    appearance: none;
    width: 100%;
    text-align: left;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 6px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 10px 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .tool-btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .tool-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .tool-btn .icon { font-size: 14px; opacity: 0.9; }
  .components { display: flex; flex-direction: column; gap: 6px; }
  .component-btn {
    appearance: none;
    width: 100%;
    text-align: left;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
    border-radius: 6px;
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    cursor: pointer;
    font: inherit;
    padding: 8px 10px;
  }
  .component-btn:hover:not(:disabled) {
    background: var(--vscode-list-hoverBackground);
    border-color: var(--vscode-focusBorder, rgba(128,128,128,0.45));
  }
  .component-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .component-btn .label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 2px; }
  .component-btn .desc {
    display: block;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.35;
  }
  .disabled-note {
    margin: 0;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  /* Builder overlay */
  .builder {
    position: absolute;
    inset: 0;
    background: var(--vscode-sideBar-background);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .builder[hidden] { display: none; }
  .builder-head {
    flex-shrink: 0;
    padding: 12px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
  }
  .builder-head h1 { margin: 0; font-size: 13px; font-weight: 600; }
  .builder-head p { margin: 3px 0 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
  /* Live preview pinned to the top; scrolls internally when tall. */
  .builder-preview {
    flex-shrink: 0;
    max-height: 45%;
    overflow: auto;
    padding: 12px 12px 0;
    background: var(--vscode-sideBar-background);
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
  }
  .builder-preview .group-label { margin-top: 0; }
  .builder-body { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
  .builder-foot {
    flex-shrink: 0;
    display: flex;
    gap: 8px;
    padding: 10px 12px;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
  }
  .builder-foot button { flex: 1; }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 12px;
  }
  input[type="text"], textarea, select {
    font: inherit;
    font-size: 12px;
    padding: 6px 8px;
    border-radius: 4px;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.45));
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    width: 100%;
  }
  textarea { resize: vertical; min-height: 50px; font-family: var(--vscode-editor-font-family, monospace); }
  button {
    appearance: none;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 4px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 7px 12px;
  }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button.tiny { padding: 3px 8px; font-size: 11px; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .list { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3)); border-radius: 6px; padding: 10px; margin-bottom: 14px; }
  .list > .list-title { font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin-bottom: 8px; display: block; }
  .list-item { border: 1px dashed var(--vscode-panel-border, rgba(128,128,128,0.4)); border-radius: 6px; padding: 10px; margin-bottom: 8px; }
  .list-item .item-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .list-item .item-noun { font-size: 11px; font-weight: 600; color: var(--vscode-foreground); }
  .group-label { font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin: 14px 0 6px; }
  .render-box {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
    border-radius: 6px;
    padding: 12px;
    background: var(--vscode-editor-background);
    font-size: 12px;
    line-height: 1.5;
  }

  /* Table grid editor */
  .grid-scroll { overflow-x: auto; margin-bottom: 8px; }
  table.grid-editor { border-collapse: collapse; }
  table.grid-editor th, table.grid-editor td {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
    padding: 4px;
    vertical-align: top;
  }
  table.grid-editor td input { min-width: 90px; }
  .grid-col-head { display: flex; flex-direction: column; gap: 4px; min-width: 110px; }
  .grid-col-head input { min-width: 90px; }
  .grid-corner { border: none !important; background: transparent; width: 1px; }
  .grid-rowdel { border: none !important; text-align: center; }
  .grid-rowdel button { padding: 2px 6px; }
  .grid-actions { display: flex; gap: 8px; }
  .grid-actions button { flex: 1; }

  /* Image builder */
  .dropzone {
    border: 1px dashed var(--vscode-panel-border, rgba(128,128,128,0.5));
    border-radius: 8px;
    padding: 18px 12px;
    text-align: center;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.08));
    margin-bottom: 12px;
  }
  .dropzone:hover { border-color: var(--vscode-focusBorder, rgba(128,128,128,0.7)); }
  .dropzone.drag {
    border-color: var(--vscode-focusBorder, #007fd4);
    background: var(--vscode-list-hoverBackground);
    color: var(--vscode-foreground);
  }
  .dropzone .big { font-size: 18px; display: block; margin-bottom: 4px; }
  .url-row { display: flex; gap: 6px; margin-bottom: 8px; }
  .url-row input { flex: 1; }
  .url-row button { flex: 0 0 auto; }
  .checkbox-row {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: flex-start;
    gap: 6px;
    width: 100%;
    text-align: left;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 12px;
  }
  .checkbox-row input {
    width: auto;
    flex: 0 0 auto;
    margin: 0;
  }
  .img-canvas-wrap {
    position: relative;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    border-radius: 6px;
    overflow: hidden;
    background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.12));
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 140px;
    max-height: 280px;
    margin-bottom: 0;
    padding: 6px;
  }
  .img-canvas-wrap[hidden] { display: none; }
  .img-canvas-wrap img {
    max-width: 100%;
    max-height: 268px;
    display: block;
  }
  #imgCropTarget { display: none; }
  .img-canvas-wrap.cropping {
    display: block;
    height: 260px;
    min-height: 0;
    max-height: 260px;
    padding: 0;
  }
  /* Cropper sizes itself to this container when cropping. */
  .img-canvas-wrap.cropping img { max-height: none; }
  .crop-tools {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin: 8px 0 2px;
  }
  .crop-tools[hidden] { display: none; }
  .crop-tools-label {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-right: 2px;
  }
  .aspect-btn.is-active {
    outline: 1px solid var(--vscode-focusBorder, #3794ff);
    outline-offset: -1px;
  }
  .range-val { font-size: 11px; color: var(--vscode-foreground); }
  .crop-hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 6px 0 10px; }
  .dims-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }
  .dims-row > label { flex: 1 1 80px; margin-bottom: 0; }
  .dims-row .dims-link {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
    font-size: 12px;
    padding-bottom: 6px;
  }
  .dims-row .dims-link input { width: auto; margin: 0; }
  .busy-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    margin-right: auto;
  }
  .busy-status[hidden] { display: none; }
  .busy-dot {
    width: 12px;
    height: 12px;
    border: 2px solid var(--vscode-descriptionForeground);
    border-top-color: var(--vscode-focusBorder, #3794ff);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="root" id="root">
    <section>
      <div class="status" id="status">Waiting for editor…</div>
    </section>
    <section>
      <h2 class="section-title">Insert</h2>
      <button type="button" class="tool-btn" id="addImageBtn" disabled>
        <span class="icon">🖼</span>
        Add image…
      </button>
      <p class="disabled-note" id="toolsNote" hidden>Tools unlock when a file inside a content root is active.</p>
    </section>
    <section>
      <h2 class="section-title">Navigation</h2>
      <button type="button" class="tool-btn" id="editMetaBtn" disabled>
        <span class="icon">🗂</span>
        Edit folder meta.json…
      </button>
    </section>
    <section>
      <h2 class="section-title">Fumadocs components</h2>
      <div class="components" id="components"></div>
    </section>
  </div>

  <div class="builder" id="builder" hidden>
    <div class="builder-head">
      <h1 id="builderTitle">Component</h1>
      <p id="builderDesc"></p>
    </div>
    <div class="builder-preview">
      <div class="group-label">Preview</div>
      <div class="render-box" id="builderRender"></div>
    </div>
    <div class="builder-body">
      <div id="builderForm"></div>
    </div>
    <div class="builder-foot">
      <button type="button" class="secondary" id="builderCancel">Cancel</button>
      <button type="button" id="builderInsert">Done</button>
    </div>
  </div>

  <div class="builder" id="imageBuilder" hidden>
    <div class="builder-head">
      <h1 id="imgTitle">Add image</h1>
      <p id="imgDesc">Drop an image, browse your computer, or paste a URL. Crop and optimize before it lands next to your MDX file.</p>
    </div>
    <div class="builder-preview" id="imgPreviewPane" hidden>
      <div class="img-canvas-wrap" id="imgCanvasWrap">
        <img id="imgCropTarget" alt="" />
        <img id="imgPreview" hidden />
      </div>
      <div class="crop-tools" id="imgCropTools" hidden>
        <span class="crop-tools-label">Aspect</span>
        <button type="button" class="secondary tiny aspect-btn is-active" data-ratio="free">Free</button>
        <button type="button" class="secondary tiny aspect-btn" data-ratio="1">1:1</button>
        <button type="button" class="secondary tiny aspect-btn" data-ratio="1.7777778">16:9</button>
        <button type="button" class="secondary tiny aspect-btn" data-ratio="1.3333333">4:3</button>
      </div>
      <p class="crop-hint" id="imgCropHint" hidden>Drag the handles to adjust the crop. Use “Reset crop” to start over.</p>
    </div>
    <div class="builder-body">
      <div class="dropzone" id="imgDrop">
        <span class="big">🖼</span>
        Drag &amp; drop an image here, or click to browse
      </div>
      <div class="url-row">
        <input type="text" id="imgUrl" placeholder="…or paste an image URL" />
        <button type="button" class="secondary" id="imgUrlLoad">Load</button>
      </div>
      <label class="checkbox-row">
        <input type="checkbox" id="imgRemote" />
        <span>Link to the URL directly (don't download)</span>
      </label>

      <div id="imgRasterControls" hidden>
        <label>Format
          <select id="imgFormat">
            <option value="image/webp" selected>WebP (recommended)</option>
            <option value="image/png">PNG</option>
            <option value="image/jpeg">JPEG</option>
          </select>
        </label>
        <label>Max width (px)
          <input type="range" id="imgMaxWidth" min="320" max="2400" step="40" value="1200" />
          <span class="range-val" id="imgMaxWidthVal">1200</span>
        </label>
        <label>Quality
          <input type="range" id="imgQuality" min="50" max="100" step="1" value="85" />
          <span class="range-val" id="imgQualityVal">85%</span>
        </label>
        <button type="button" class="secondary tiny" id="imgResetCrop">Reset crop</button>
      </div>

      <div style="margin-top:14px">
        <label>File name
          <input type="text" id="imgFileName" value="image" />
        </label>
        <label>Alt text
          <input type="text" id="imgAlt" value="" placeholder="Describe the image" />
        </label>
        <div class="dims-row">
          <label>Width (px)
            <input type="number" id="imgWidth" min="1" step="1" placeholder="auto" />
          </label>
          <label>Height (px)
            <input type="number" id="imgHeight" min="1" step="1" placeholder="auto" />
          </label>
          <label class="dims-link">
            <input type="checkbox" id="imgLinkDims" checked />
            <span>Lock ratio</span>
          </label>
        </div>
        <p class="crop-hint" id="imgDimsHint">Writes width/height on the &lt;img&gt; tag for Next.js Image Optimization. Auto-filled from the crop; clear to omit.</p>
        <label id="imgSubfolderLabel">Subfolder (relative)
          <input type="text" id="imgSubfolder" value="images" />
        </label>
      </div>
      <p class="error" id="imgError" hidden style="color:var(--vscode-errorForeground);font-size:12px"></p>
    </div>
    <div class="builder-foot">
      <span class="busy-status" id="imgBusy" hidden><span class="busy-dot"></span><span id="imgBusyText">Applying…</span></span>
      <button type="button" class="secondary" id="imgCancel">Cancel</button>
      <button type="button" id="imgSave">Insert image</button>
    </div>
  </div>

<script>${cropperJs}</script>
<script>
(function () {
  const vscode = acquireVsCodeApi();
  const statusEl = document.getElementById('status');
  const addImageBtn = document.getElementById('addImageBtn');
  const editMetaBtn = document.getElementById('editMetaBtn');
  const toolsNote = document.getElementById('toolsNote');
  const componentsEl = document.getElementById('components');

  const builder = document.getElementById('builder');
  const builderTitle = document.getElementById('builderTitle');
  const builderDesc = document.getElementById('builderDesc');
  const builderForm = document.getElementById('builderForm');
  const builderRender = document.getElementById('builderRender');
  const builderInsert = document.getElementById('builderInsert');
  const builderCancel = document.getElementById('builderCancel');
  const componentMime = '${FUMADOCS_COMPONENT_MIME}';

  let enabledState = false;

  function esc(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }
  function jsStr(s) { return String(s == null ? '' : s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'"); }
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function nl2br(s) { return escHtml(s).replace(/\\n/g, '<br>'); }

  // Read a double-quoted JSX attribute value out of a tag's source.
  function attr(src, name) {
    const m = String(src || '').match(new RegExp(name + '\\\\s*=\\\\s*"([^"]*)"'));
    return m ? m[1] : null;
  }
  // Inner content of a single-element block: between the first '>' and the
  // final '</Tag>'.
  function innerOf(text, tag) {
    return String(text || '')
      .replace(/^[\\s\\S]*?>/, '')
      .replace(new RegExp('</' + tag + '>\\\\s*$'), '')
      .trim();
  }

  const COMPONENTS = {
    callout: {
      title: 'Callout',
      description: 'Highlight info, warnings, errors, success, or ideas.',
      fields: [
        { key: 'type', label: 'Type', type: 'select', options: ['info', 'warn', 'error', 'success', 'idea', '(default)'], default: 'info' },
        { key: 'title', label: 'Title (optional)', type: 'text', default: '', placeholder: 'Heads up' },
        { key: 'body', label: 'Body', type: 'textarea', default: 'Your message here.' },
      ],
      lists: [],
      build: function (v) {
        const typeAttr = v.type && v.type !== '(default)' ? ' type="' + esc(v.type) + '"' : '';
        const titleAttr = v.title && v.title.trim() ? ' title="' + esc(v.title.trim()) + '"' : '';
        return '<Callout' + typeAttr + titleAttr + '>\\n\\n' + (v.body || '') + '\\n\\n</Callout>';
      },
      parse: function (text) {
        const open = (text.match(/^[\\s\\S]*?>/) || [''])[0];
        return {
          type: attr(open, 'type') || '(default)',
          title: attr(open, 'title') || '',
          body: innerOf(text, 'Callout'),
        };
      },
      render: function (v) {
        const colors = { info: '#3b82f6', warn: '#f59e0b', error: '#ef4444', success: '#22c55e', idea: '#a855f7' };
        const c = colors[v.type] || '#6b7280';
        const title = v.title && v.title.trim()
          ? '<div style="font-weight:600;margin-bottom:4px">' + escHtml(v.title) + '</div>' : '';
        return '<div style="border-left:3px solid ' + c + ';background:' + c + '22;padding:8px 10px;border-radius:4px">'
          + title + '<div>' + nl2br(v.body) + '</div></div>';
      },
    },
    banner: {
      title: 'Banner',
      description: 'Dismissible announcement strip at the top of the page.',
      fields: [
        { key: 'id', label: 'Banner id (for dismiss persistence)', type: 'text', default: 'announcement' },
        { key: 'variant', label: 'Variant', type: 'select', options: ['normal', 'rainbow'], default: 'normal' },
        { key: 'content', label: 'Content', type: 'textarea', default: '**Announcement** — Your message here.' },
      ],
      lists: [],
      build: function (v) {
        const variantAttr = v.variant && v.variant !== 'normal' ? ' variant="' + esc(v.variant) + '"' : '';
        return '<Banner id="' + esc(v.id || 'announcement') + '"' + variantAttr + '>\\n\\n' + (v.content || '') + '\\n\\n</Banner>';
      },
      parse: function (text) {
        const open = (text.match(/^[\\s\\S]*?>/) || [''])[0];
        return {
          id: attr(open, 'id') || 'announcement',
          variant: attr(open, 'variant') || 'normal',
          content: innerOf(text, 'Banner'),
        };
      },
      render: function (v) {
        const rainbow = v.variant === 'rainbow';
        const bg = rainbow
          ? 'linear-gradient(90deg,#ff6b6b,#feca57,#48dbfb,#ff9ff3,#54a0ff)'
          : 'var(--vscode-editorWidget-background, rgba(128,128,128,0.15))';
        const color = rainbow ? '#1a1a1a' : 'inherit';
        return '<div style="padding:8px 10px;border-radius:4px;text-align:center;background:' + bg + ';color:' + color + '">'
          + nl2br(v.content) + '</div>';
      },
    },
    tabs: {
      title: 'Tabs',
      description: 'Grouped tabbed content.',
      fields: [],
      lists: [{
        key: 'tabs', noun: 'Tab', min: 1,
        fields: [
          { key: 'value', label: 'Tab label', type: 'text', default: 'Tab' },
          { key: 'content', label: 'Content', type: 'textarea', default: 'Tab content.' },
        ],
        default: [
          { value: 'Overview', content: 'Overview content.' },
          { value: 'Details', content: 'Details content.' },
        ],
      }],
      build: function (v) {
        const tabs = v.tabs || [];
        const items = tabs.map(function (t) { return "'" + jsStr(t.value) + "'"; }).join(', ');
        const body = tabs.map(function (t) {
          return '  <Tab value="' + esc(t.value) + '">\\n\\n' + (t.content || '') + '\\n\\n  </Tab>';
        }).join('\\n');
        return '<Tabs items={[' + items + ']}>\\n' + body + '\\n</Tabs>';
      },
      parse: function (text) {
        const tabs = [];
        const re = /<Tab\\s+value="([^"]*)"\\s*>([\\s\\S]*?)<\\/Tab>/g;
        let m;
        while ((m = re.exec(text))) tabs.push({ value: m[1], content: m[2].trim() });
        return { tabs: tabs };
      },
      render: function (v, ui) {
        const tabs = v.tabs || [];
        const active = Math.min((ui && ui.tab) || 0, Math.max(0, tabs.length - 1));
        const head = tabs.map(function (t, i) {
          return '<span data-action="tab" data-index="' + i + '" style="cursor:pointer;padding:4px 10px;border-bottom:2px solid ' + (i === active ? 'var(--vscode-focusBorder)' : 'transparent')
            + ';opacity:' + (i === active ? '1' : '0.6') + '">' + escHtml(t.value) + '</span>';
        }).join('');
        const body = tabs.length ? nl2br(tabs[active].content) : '';
        return '<div><div style="display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--vscode-panel-border);margin-bottom:8px">'
          + head + '</div><div>' + body + '</div></div>';
      },
    },
    steps: {
      title: 'Steps',
      description: 'Numbered procedural steps.',
      fields: [],
      lists: [{
        key: 'steps', noun: 'Step', min: 1,
        fields: [
          { key: 'title', label: 'Step title', type: 'text', default: 'Step title' },
          { key: 'content', label: 'Content', type: 'textarea', default: 'Step content goes here.' },
        ],
        default: [
          { title: 'Install dependencies', content: 'Run the install command.' },
          { title: 'Configure environment', content: 'Set your environment variables.' },
        ],
      }],
      build: function (v) {
        const steps = v.steps || [];
        const body = steps.map(function (s) {
          return '  <Step>\\n\\n### ' + (s.title || '') + '\\n\\n' + (s.content || '') + '\\n\\n  </Step>';
        }).join('\\n');
        return '<Steps>\\n' + body + '\\n</Steps>';
      },
      parse: function (text) {
        const steps = [];
        const re = /<Step\\s*>([\\s\\S]*?)<\\/Step>/g;
        let m;
        while ((m = re.exec(text))) {
          let inner = m[1].trim();
          let title = '';
          const tm = inner.match(/^#{1,6}\\s*(.*)/);
          if (tm) { title = tm[1].trim(); inner = inner.slice(tm[0].length).trim(); }
          steps.push({ title: title, content: inner });
        }
        return { steps: steps };
      },
      render: function (v) {
        const steps = v.steps || [];
        const items = steps.map(function (s, i) {
          return '<div style="display:flex;gap:8px;margin-bottom:10px">'
            + '<div style="flex:0 0 22px;height:22px;border-radius:50%;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600">' + (i + 1) + '</div>'
            + '<div><div style="font-weight:600">' + escHtml(s.title) + '</div><div style="opacity:0.85">' + nl2br(s.content) + '</div></div></div>';
        }).join('');
        return '<div style="border-left:1px solid var(--vscode-panel-border);padding-left:8px">' + items + '</div>';
      },
    },
    cards: {
      title: 'Cards',
      description: 'Grid of link cards.',
      fields: [],
      lists: [{
        key: 'cards', noun: 'Card', min: 1,
        fields: [
          { key: 'title', label: 'Title', type: 'text', default: 'Card title' },
          { key: 'description', label: 'Description (optional)', type: 'text', default: '' },
          { key: 'href', label: 'Link (href)', type: 'text', default: '/' },
          { key: 'external', label: 'External link', type: 'select', options: ['no', 'yes'], default: 'no' },
        ],
        default: [
          { title: 'First card', description: 'Short description.', href: '/', external: 'no' },
          { title: 'Second card', description: 'More detail.', href: '/', external: 'no' },
        ],
      }],
      build: function (v) {
        const cards = v.cards || [];
        const body = cards.map(function (c) {
          const desc = c.description && c.description.trim() ? '\\n    description="' + esc(c.description.trim()) + '"' : '';
          const ext = c.external === 'yes' ? '\\n    external' : '';
          return '  <Card\\n    title="' + esc(c.title) + '"' + desc + '\\n    href="' + esc(c.href) + '"' + ext + '\\n  />';
        }).join('\\n');
        return '<Cards>\\n' + body + '\\n</Cards>';
      },
      parse: function (text) {
        const cards = [];
        const re = /<Card\\b([\\s\\S]*?)\\/>/g;
        let m;
        while ((m = re.exec(text))) {
          const seg = m[1];
          cards.push({
            title: attr(seg, 'title') || '',
            description: attr(seg, 'description') || '',
            href: attr(seg, 'href') || '/',
            external: /(^|\\s)external(\\s|\\/|>|$)/.test(seg) ? 'yes' : 'no',
          });
        }
        return { cards: cards };
      },
      render: function (v) {
        const cards = v.cards || [];
        const items = cards.map(function (c) {
          const desc = c.description && c.description.trim()
            ? '<div style="opacity:0.8;font-size:11px;margin-top:2px">' + escHtml(c.description) + '</div>' : '';
          const ext = c.external === 'yes' ? ' ↗' : '';
          return '<div style="border:1px solid var(--vscode-panel-border);border-radius:6px;padding:8px 10px">'
            + '<div style="font-weight:600">' + escHtml(c.title) + ext + '</div>' + desc
            + '<div style="opacity:0.55;font-size:10px;margin-top:4px">' + escHtml(c.href) + '</div></div>';
        }).join('');
        return '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:6px">' + items + '</div>';
      },
    },
    accordions: {
      title: 'Accordions',
      description: 'Collapsible FAQ-style sections.',
      fields: [
        { key: 'type', label: 'Open behavior', type: 'select', options: ['single', 'multiple'], default: 'single' },
      ],
      lists: [{
        key: 'items', noun: 'Accordion', min: 1,
        fields: [
          { key: 'title', label: 'Title', type: 'text', default: 'Question' },
          { key: 'content', label: 'Content', type: 'textarea', default: 'Answer goes here.' },
        ],
        default: [
          { title: 'First question', content: 'Answer to the first question.' },
          { title: 'Second question', content: 'Answer to the second question.' },
        ],
      }],
      build: function (v) {
        const items = v.items || [];
        const body = items.map(function (it) {
          return '  <Accordion title="' + esc(it.title) + '">\\n\\n' + (it.content || '') + '\\n\\n  </Accordion>';
        }).join('\\n');
        return '<Accordions type="' + esc(v.type || 'single') + '">\\n' + body + '\\n</Accordions>';
      },
      parse: function (text) {
        const open = (text.match(/^[\\s\\S]*?>/) || [''])[0];
        const items = [];
        const re = /<Accordion\\s+title="([^"]*)"\\s*>([\\s\\S]*?)<\\/Accordion>/g;
        let m;
        while ((m = re.exec(text))) items.push({ title: m[1], content: m[2].trim() });
        return { type: attr(open, 'type') || 'single', items: items };
      },
      render: function (v, ui) {
        const items = v.items || [];
        const openMap = (ui && ui.open) || {};
        const rows = items.map(function (it, i) {
          const open = !!openMap[i];
          const body = open
            ? '<div style="padding:0 10px 8px;opacity:0.85">' + nl2br(it.content) + '</div>' : '';
          return '<div style="border:1px solid var(--vscode-panel-border);border-radius:4px;margin-bottom:4px">'
            + '<div data-action="accordion" data-index="' + i + '" style="cursor:pointer;padding:6px 10px;font-weight:600;display:flex;justify-content:space-between"><span>' + escHtml(it.title) + '</span>'
            + '<span style="opacity:0.6">' + (open ? '▾' : '▸') + '</span></div>' + body + '</div>';
        }).join('');
        return '<div>' + rows + '</div>';
      },
    },
    'code-block-tabs': {
      title: 'CodeBlockTabs',
      description: 'Tabbed code blocks (e.g. package managers).',
      fields: [],
      lists: [{
        key: 'tabs', noun: 'Tab', min: 1,
        fields: [
          { key: 'label', label: 'Tab label', type: 'text', default: 'npm' },
          { key: 'language', label: 'Language', type: 'text', default: 'bash' },
          { key: 'code', label: 'Code', type: 'textarea', default: 'npm install package-name' },
        ],
        default: [
          { label: 'npm', language: 'bash', code: 'npm install package-name' },
          { label: 'pnpm', language: 'bash', code: 'pnpm add package-name' },
        ],
      }],
      build: function (v) {
        const tabs = v.tabs || [];
        const triggers = tabs.map(function (t) {
          return '    <CodeBlockTabsTrigger value="' + esc(t.label) + '">' + (t.label || '') + '</CodeBlockTabsTrigger>';
        }).join('\\n');
        const panels = tabs.map(function (t) {
          return '  <CodeBlockTab value="' + esc(t.label) + '">\\n\\n\\u0060\\u0060\\u0060' + (t.language || '') + '\\n' + (t.code || '') + '\\n\\u0060\\u0060\\u0060\\n\\n  </CodeBlockTab>';
        }).join('\\n');
        const def = tabs.length ? tabs[0].label : '';
        return '<CodeBlockTabs defaultValue="' + esc(def) + '">\\n  <CodeBlockTabsList>\\n' + triggers + '\\n  </CodeBlockTabsList>\\n' + panels + '\\n</CodeBlockTabs>';
      },
      parse: function (text) {
        const tabs = [];
        const re = /<CodeBlockTab\\s+value="([^"]*)"\\s*>([\\s\\S]*?)<\\/CodeBlockTab>/g;
        let m;
        while ((m = re.exec(text))) {
          const inner = m[2];
          const fm = inner.match(/\\u0060\\u0060\\u0060(\\w*)\\n([\\s\\S]*?)\\u0060\\u0060\\u0060/);
          tabs.push({
            label: m[1],
            language: fm ? (fm[1] || 'bash') : 'bash',
            code: fm ? fm[2].replace(/\\n$/, '') : inner.trim(),
          });
        }
        return { tabs: tabs };
      },
      render: function (v, ui) {
        const tabs = v.tabs || [];
        const active = Math.min((ui && ui.codeTab) || 0, Math.max(0, tabs.length - 1));
        const head = tabs.map(function (t, i) {
          return '<span data-action="codeTab" data-index="' + i + '" style="cursor:pointer;padding:4px 10px;border-bottom:2px solid ' + (i === active ? 'var(--vscode-focusBorder)' : 'transparent')
            + ';opacity:' + (i === active ? '1' : '0.6') + '">' + escHtml(t.label) + '</span>';
        }).join('');
        const code = tabs.length ? escHtml(tabs[active].code) : '';
        return '<div><div style="display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--vscode-panel-border);margin-bottom:6px">'
          + head + '</div><pre style="margin:0;padding:8px;background:var(--vscode-textCodeBlock-background, rgba(128,128,128,0.12));border-radius:4px;white-space:pre-wrap;font-family:var(--vscode-editor-font-family,monospace);font-size:11px">'
          + code + '</pre></div>';
      },
    },
    codeblock: {
      title: 'Code block',
      description: 'Fenced code block with language and optional title.',
      fields: [
        { key: 'language', label: 'Language', type: 'datalist', default: 'ts',
          options: ['ts', 'tsx', 'js', 'jsx', 'json', 'bash', 'sh', 'python', 'rust', 'go', 'c', 'cpp', 'java', 'html', 'css', 'scss', 'yaml', 'toml', 'sql', 'md', 'mdx', 'diff', 'text'] },
        { key: 'title', label: 'Title (optional)', type: 'text', default: '', placeholder: 'config.ts' },
        { key: 'code', label: 'Code', type: 'textarea', default: 'console.log("hello world");' },
      ],
      lists: [],
      build: function (v) {
        const lang = (v.language || '').trim();
        const title = (v.title || '').trim();
        const meta = title ? ' title="' + title.replace(/"/g, "'") + '"' : '';
        const f = '\\u0060\\u0060\\u0060';
        return f + lang + meta + '\\n' + (v.code || '') + '\\n' + f;
      },
      parse: function (text) {
        const lines = String(text || '').replace(/\\r\\n?/g, '\\n').split('\\n');
        const first = lines[0] || '';
        const fm = first.match(/^\\s*(?:\\u0060\\u0060\\u0060|~~~)\\s*(\\S*)\\s*(.*)$/);
        let language = '', title = '';
        if (fm) {
          language = fm[1] || '';
          const tm = (fm[2] || '').match(/title="([^"]*)"/);
          if (tm) title = tm[1];
        }
        let body = lines.slice(1);
        if (body.length && /^\\s*(\\u0060\\u0060\\u0060|~~~)\\s*$/.test(body[body.length - 1])) {
          body = body.slice(0, -1);
        }
        return { language: language, title: title, code: body.join('\\n') };
      },
      render: function (v) {
        const lang = (v.language || '').trim();
        const title = (v.title || '').trim();
        const head = (lang || title)
          ? '<div style="font-size:11px;opacity:0.7;margin-bottom:4px">' + escHtml(title || lang) + (title && lang ? ' · ' + escHtml(lang) : '') + '</div>'
          : '';
        return '<div>' + head + '<pre style="margin:0;padding:8px;background:var(--vscode-textCodeBlock-background, rgba(128,128,128,0.12));border-radius:4px;white-space:pre-wrap;font-family:var(--vscode-editor-font-family,monospace);font-size:11px">'
          + escHtml(v.code || '') + '</pre></div>';
      },
    },
    table: {
      title: 'Table',
      description: 'Markdown table with rows, columns, and alignment.',
      fields: [],
      lists: [],
      grid: {
        default: {
          columns: [
            { header: 'Column 1', align: '' },
            { header: 'Column 2', align: '' },
          ],
          rows: [
            ['Cell', 'Cell'],
            ['Cell', 'Cell'],
          ],
        },
      },
      build: function (v) {
        const g = (v.grid && v.grid.columns) ? v.grid : { columns: [{ header: 'Column', align: '' }], rows: [] };
        const cols = g.columns.length ? g.columns : [{ header: 'Column', align: '' }];
        const cell = function (s) { return String(s == null ? '' : s).replace(/\\|/g, '\\\\|').replace(/\\n/g, ' ').trim(); };
        const header = '| ' + cols.map(function (c) { return cell(c.header) || ' '; }).join(' | ') + ' |';
        const delim = '| ' + cols.map(function (c) {
          if (c.align === 'center') return ':---:';
          if (c.align === 'right') return '---:';
          if (c.align === 'left') return ':---';
          return '---';
        }).join(' | ') + ' |';
        const rows = (g.rows || []).map(function (r) {
          return '| ' + cols.map(function (_c, i) { return cell(r[i]) || ' '; }).join(' | ') + ' |';
        });
        return [header, delim].concat(rows).join('\\n');
      },
      parse: function (text) {
        const lines = String(text || '').replace(/\\r\\n?/g, '\\n').split('\\n').filter(function (l) { return l.trim() !== ''; });
        if (lines.length < 2) return { grid: null };
        const split = function (line) {
          let s = line.trim();
          if (s.charAt(0) === '|') s = s.slice(1);
          if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
          const out = [];
          let cur = '';
          for (let i = 0; i < s.length; i++) {
            if (s.charAt(i) === '\\\\' && s.charAt(i + 1) === '|') { cur += '|'; i++; continue; }
            if (s.charAt(i) === '|') { out.push(cur.trim()); cur = ''; continue; }
            cur += s.charAt(i);
          }
          out.push(cur.trim());
          return out;
        };
        const headers = split(lines[0]);
        const delims = split(lines[1]);
        const columns = headers.map(function (h, i) {
          const d = (delims[i] || '').trim();
          const l = d.charAt(0) === ':';
          const r = d.charAt(d.length - 1) === ':';
          let align = '';
          if (l && r) align = 'center';
          else if (r) align = 'right';
          else if (l) align = 'left';
          return { header: h, align: align };
        });
        const rows = lines.slice(2).map(function (line) {
          const cells = split(line);
          const row = [];
          for (let i = 0; i < columns.length; i++) row.push(cells[i] != null ? cells[i] : '');
          return row;
        });
        return { grid: { columns: columns, rows: rows } };
      },
      render: function (v) {
        const g = (v.grid && v.grid.columns) ? v.grid : { columns: [], rows: [] };
        const alignCss = function (a) { return a ? 'text-align:' + a + ';' : ''; };
        const head = '<tr>' + g.columns.map(function (c) {
          return '<th style="border:1px solid var(--vscode-panel-border);padding:4px 8px;' + alignCss(c.align) + '">' + escHtml(c.header) + '</th>';
        }).join('') + '</tr>';
        const body = (g.rows || []).map(function (r) {
          return '<tr>' + g.columns.map(function (_c, i) {
            return '<td style="border:1px solid var(--vscode-panel-border);padding:4px 8px;' + alignCss(g.columns[i].align) + '">' + escHtml(r[i] || '') + '</td>';
          }).join('') + '</tr>';
        }).join('');
        return '<table style="border-collapse:collapse;font-size:11px;width:100%">' + head + body + '</table>';
      },
    },
  };

  let activeDef = null;
  let editing = false;
  let state = { scalars: {}, lists: {}, grid: null };
  // Transient interaction state for the live preview (active tab, open rows…).
  let previewUi = { tab: 0, codeTab: 0, open: { 0: true } };

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function defaultComponentText(id) {
    const def = COMPONENTS[id];
    if (!def) return '';
    const scalars = {};
    const lists = {};
    let grid = null;
    for (const field of def.fields) scalars[field.key] = field.default;
    for (const listDef of def.lists) lists[listDef.key] = clone(listDef.default);
    if (def.grid) grid = clone(def.grid.default);
    const prev = state;
    state = { scalars: scalars, lists: lists, grid: grid };
    try {
      return def.build(collect());
    } finally {
      state = prev;
    }
  }

  function collect() {
    const v = {};
    for (const k in state.scalars) v[k] = state.scalars[k];
    for (const k in state.lists) v[k] = state.lists[k];
    if (state.grid) v.grid = state.grid;
    return v;
  }

  function updatePreview() {
    if (!activeDef) return;
    const v = collect();
    try {
      builderRender.innerHTML = activeDef.render(v, previewUi);
    } catch (err) {
      builderRender.textContent = 'preview error: ' + (err && err.message);
    }
  }

  let liveTimer = null;

  // Build the component markup from the current form state.
  function buildText() {
    if (!activeDef) return '';
    try { return activeDef.build(collect()); } catch (err) { return ''; }
  }

  // Write the current component straight into the document.
  function liveApplyNow() {
    if (!activeDef) return;
    const text = buildText();
    if (!text.trim()) return;
    vscode.postMessage({ type: 'liveApply', text: text, mode: editing ? 'edit' : 'insert' });
  }

  // Debounced live apply: keeps the file in sync as you edit fields.
  function scheduleLiveApply() {
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = setTimeout(liveApplyNow, 200);
  }

  // The render-box is re-filled on every update, so delegate clicks from the
  // stable container to keep the preview interactive.
  builderRender.addEventListener('click', function (e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.getAttribute('data-action');
    const index = parseInt(el.getAttribute('data-index') || '0', 10);
    if (action === 'tab') previewUi.tab = index;
    else if (action === 'codeTab') previewUi.codeTab = index;
    else if (action === 'accordion') previewUi.open[index] = !previewUi.open[index];
    updatePreview();
  });

  function makeField(field, value, onInput) {
    const label = document.createElement('label');
    label.textContent = field.label;
    let control;
    if (field.type === 'select') {
      control = document.createElement('select');
      for (const opt of field.options) {
        const o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        if (opt === value) o.selected = true;
        control.appendChild(o);
      }
    } else if (field.type === 'datalist') {
      control = document.createElement('input');
      control.type = 'text';
      control.value = value || '';
      if (field.placeholder) control.placeholder = field.placeholder;
      const listId = 'dl-' + field.key + '-' + Math.random().toString(36).slice(2, 7);
      const dl = document.createElement('datalist');
      dl.id = listId;
      for (const opt of (field.options || [])) {
        const o = document.createElement('option');
        o.value = opt;
        dl.appendChild(o);
      }
      control.setAttribute('list', listId);
      label.appendChild(dl);
    } else if (field.type === 'textarea') {
      control = document.createElement('textarea');
      control.value = value || '';
      if (field.placeholder) control.placeholder = field.placeholder;
    } else {
      control = document.createElement('input');
      control.type = 'text';
      control.value = value || '';
      if (field.placeholder) control.placeholder = field.placeholder;
    }
    control.addEventListener('input', function () { onInput(control.value); scheduleLiveApply(); });
    control.addEventListener('change', function () { onInput(control.value); scheduleLiveApply(); });
    label.appendChild(control);
    return label;
  }

  function renderList(listDef) {
    const wrap = document.createElement('div');
    wrap.className = 'list';
    const title = document.createElement('span');
    title.className = 'list-title';
    title.textContent = listDef.key;
    wrap.appendChild(title);

    const itemsContainer = document.createElement('div');
    wrap.appendChild(itemsContainer);

    function renderItems() {
      itemsContainer.innerHTML = '';
      const items = state.lists[listDef.key];
      items.forEach(function (item, index) {
        const itemEl = document.createElement('div');
        itemEl.className = 'list-item';
        const head = document.createElement('div');
        head.className = 'item-head';
        const noun = document.createElement('span');
        noun.className = 'item-noun';
        noun.textContent = listDef.noun + ' ' + (index + 1);
        head.appendChild(noun);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'secondary tiny';
        remove.textContent = 'Remove';
        remove.disabled = items.length <= listDef.min;
        remove.addEventListener('click', function () {
          items.splice(index, 1);
          renderItems();
          updatePreview();
          scheduleLiveApply();
        });
        head.appendChild(remove);
        itemEl.appendChild(head);

        for (const field of listDef.fields) {
          itemEl.appendChild(makeField(field, item[field.key], function (val) {
            item[field.key] = val;
            updatePreview();
          }));
        }
        itemsContainer.appendChild(itemEl);
      });
    }

    renderItems();

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'secondary';
    add.textContent = '+ Add ' + listDef.noun.toLowerCase();
    add.addEventListener('click', function () {
      const blank = {};
      for (const field of listDef.fields) blank[field.key] = field.default || '';
      state.lists[listDef.key].push(blank);
      renderItems();
      updatePreview();
      scheduleLiveApply();
    });
    wrap.appendChild(add);
    return wrap;
  }

  // A bare text input (no label wrapper) used inside the table grid cells.
  function makeCellInput(value, placeholder, onInput) {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = value || '';
    if (placeholder) inp.placeholder = placeholder;
    inp.addEventListener('input', function () { onInput(inp.value); scheduleLiveApply(); });
    return inp;
  }

  // 2D table editor: edit headers + alignment, add/remove rows and columns.
  function renderGrid() {
    const wrap = document.createElement('div');
    wrap.className = 'list';
    const title = document.createElement('span');
    title.className = 'list-title';
    title.textContent = 'Columns & rows';
    wrap.appendChild(title);

    const scroll = document.createElement('div');
    scroll.className = 'grid-scroll';
    wrap.appendChild(scroll);

    function draw() {
      const g = state.grid || (state.grid = { columns: [], rows: [] });
      scroll.innerHTML = '';
      const table = document.createElement('table');
      table.className = 'grid-editor';

      const headRow = document.createElement('tr');
      g.columns.forEach(function (col, ci) {
        const th = document.createElement('th');
        const colWrap = document.createElement('div');
        colWrap.className = 'grid-col-head';
        colWrap.appendChild(makeCellInput(col.header, 'Header', function (val) {
          col.header = val; updatePreview();
        }));
        const align = document.createElement('select');
        [['', 'default'], ['left', 'left'], ['center', 'center'], ['right', 'right']].forEach(function (o) {
          const opt = document.createElement('option');
          opt.value = o[0]; opt.textContent = o[1];
          if (o[0] === (col.align || '')) opt.selected = true;
          align.appendChild(opt);
        });
        align.addEventListener('change', function () {
          col.align = align.value; updatePreview(); scheduleLiveApply();
        });
        colWrap.appendChild(align);
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'secondary tiny';
        del.textContent = 'Remove column';
        del.disabled = g.columns.length <= 1;
        del.addEventListener('click', function () {
          if (g.columns.length <= 1) return;
          g.columns.splice(ci, 1);
          g.rows.forEach(function (r) { r.splice(ci, 1); });
          draw(); updatePreview(); scheduleLiveApply();
        });
        colWrap.appendChild(del);
        th.appendChild(colWrap);
        headRow.appendChild(th);
      });
      const corner = document.createElement('th');
      corner.className = 'grid-corner';
      headRow.appendChild(corner);
      table.appendChild(headRow);

      g.rows.forEach(function (row, ri) {
        const tr = document.createElement('tr');
        g.columns.forEach(function (_col, ci) {
          const td = document.createElement('td');
          td.appendChild(makeCellInput(row[ci], '', function (val) {
            row[ci] = val; updatePreview();
          }));
          tr.appendChild(td);
        });
        const td = document.createElement('td');
        td.className = 'grid-rowdel';
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'secondary tiny';
        del.textContent = '✕';
        del.title = 'Remove row';
        del.disabled = g.rows.length <= 1;
        del.addEventListener('click', function () {
          if (g.rows.length <= 1) return;
          g.rows.splice(ri, 1);
          draw(); updatePreview(); scheduleLiveApply();
        });
        td.appendChild(del);
        tr.appendChild(td);
        table.appendChild(tr);
      });

      scroll.appendChild(table);
    }

    draw();

    const actions = document.createElement('div');
    actions.className = 'grid-actions';
    const addRow = document.createElement('button');
    addRow.type = 'button'; addRow.className = 'secondary';
    addRow.textContent = '+ Add row';
    addRow.addEventListener('click', function () {
      const g = state.grid;
      g.rows.push(g.columns.map(function () { return ''; }));
      draw(); updatePreview(); scheduleLiveApply();
    });
    const addCol = document.createElement('button');
    addCol.type = 'button'; addCol.className = 'secondary';
    addCol.textContent = '+ Add column';
    addCol.addEventListener('click', function () {
      const g = state.grid;
      g.columns.push({ header: 'Column ' + (g.columns.length + 1), align: '' });
      g.rows.forEach(function (r) { r.push(''); });
      draw(); updatePreview(); scheduleLiveApply();
    });
    actions.appendChild(addRow);
    actions.appendChild(addCol);
    wrap.appendChild(actions);

    return wrap;
  }

  function renderForm(def) {
    builderForm.innerHTML = '';
    for (const field of def.fields) {
      builderForm.appendChild(makeField(field, state.scalars[field.key], function (val) {
        state.scalars[field.key] = val;
        updatePreview();
      }));
    }
    for (const listDef of def.lists) {
      builderForm.appendChild(renderList(listDef));
    }
    if (def.grid) builderForm.appendChild(renderGrid());
  }

  // Seed builder state from defaults, overlaying any parsed initial values.
  function seedState(def, initial) {
    state = { scalars: {}, lists: {}, grid: null };
    for (const field of def.fields) {
      state.scalars[field.key] =
        initial && initial[field.key] != null ? initial[field.key] : field.default;
    }
    for (const listDef of def.lists) {
      const v = initial && initial[listDef.key];
      state.lists[listDef.key] =
        Array.isArray(v) && v.length ? clone(v) : clone(listDef.default);
    }
    if (def.grid) {
      const g = initial && initial.grid;
      state.grid =
        g && g.columns && g.columns.length ? clone(g) : clone(def.grid.default);
    }
  }

  function showBuilder(def, initial) {
    activeDef = def;
    builderTitle.textContent = (editing ? 'Edit ' : '') + def.title;
    builderDesc.textContent = def.description;
    // Changes are written live, so the primary action just closes the builder.
    builderInsert.textContent = 'Done';
    previewUi = { tab: 0, codeTab: 0, open: { 0: true } };
    seedState(def, initial);
    renderForm(def);
    updatePreview();
    builder.hidden = false;
  }

  function openBuilder(id) {
    const def = COMPONENTS[id];
    if (!def) return;
    editing = false;
    showBuilder(def, null);
    // Drop the default block into the document immediately; edits update it.
    liveApplyNow();
  }

  function openBuilderEdit(id, text) {
    const def = COMPONENTS[id];
    if (!def) return;
    editing = true;
    let initial = null;
    try { initial = def.parse ? def.parse(text) : null; } catch (err) { initial = null; }
    showBuilder(def, initial);
  }

  function closeBuilder() {
    builder.hidden = true;
    activeDef = null;
    editing = false;
  }

  function basename(p) {
    if (!p) return '';
    const parts = p.replace(/\\\\/g, '/').split('/');
    return parts[parts.length - 1] || p;
  }

  function renderComponents(components, enabled) {
    componentsEl.innerHTML = '';
    for (const c of components) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'component-btn';
      btn.disabled = !enabled;
      btn.innerHTML =
        '<span class="label">' + c.label + '</span>' +
        '<span class="desc">' + c.description + '</span>';
      btn.draggable = !!enabled;
      btn.addEventListener('dragstart', function (e) {
        if (!enabled || !e.dataTransfer) return;
        const text = c.configurable ? defaultComponentText(c.id) : (c.snippet || '');
        if (!text.trim()) return;
        const payload = JSON.stringify({ id: c.id, label: c.label, snippet: text });
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData(componentMime, payload);
        e.dataTransfer.setData('text/plain', text);
      });
      btn.addEventListener('click', function () {
        if (!enabled) return;
        if (c.configurable) openBuilder(c.id);
        else vscode.postMessage({ type: 'insertComponent', id: c.id });
      });
      componentsEl.appendChild(btn);
    }
  }

  function applyState(msg) {
    const ctx = msg.context;
    enabledState = !!ctx.enabled;
    addImageBtn.disabled = !enabledState;
    if (editMetaBtn) editMetaBtn.disabled = !enabledState;
    toolsNote.hidden = enabledState;
    // Keep an in-progress edit open even if the active editor briefly changes.
    if (!enabledState && !editing) closeBuilder();
    if (!enabledState && !imgIsEdit) imgClose();

    if (enabledState) {
      statusEl.className = 'status active';
      statusEl.innerHTML =
        '<div class="ctx-name">' + escHtml(ctx.name || basename(ctx.contentRoot)) + '</div>' +
        '<div class="ctx-file">' + escHtml(basename(ctx.filePath)) + '</div>';
    } else {
      statusEl.className = 'status';
      statusEl.textContent = ctx.reason || 'Open an MDX file under a content root.';
    }

    renderComponents(msg.components || [], enabledState);
  }

  addImageBtn.addEventListener('click', function () {
    if (addImageBtn.disabled) return;
    vscode.postMessage({ type: 'addImage' });
  });
  if (editMetaBtn) editMetaBtn.addEventListener('click', function () {
    if (editMetaBtn.disabled) return;
    vscode.postMessage({ type: 'editMeta' });
  });
  builderCancel.addEventListener('click', function () {
    if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
    vscode.postMessage({ type: 'cancelEdit' });
    closeBuilder();
  });
  builderInsert.addEventListener('click', function () {
    // Flush any pending change so the final state is written before finishing.
    if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
    liveApplyNow();
    vscode.postMessage({ type: 'finishEdit' });
    closeBuilder();
  });

  // ----- Image builder -----------------------------------------------------
  const imageBuilder = document.getElementById('imageBuilder');
  const imgTitle = document.getElementById('imgTitle');
  const imgDesc = document.getElementById('imgDesc');
  const imgDrop = document.getElementById('imgDrop');
  const imgUrl = document.getElementById('imgUrl');
  const imgUrlLoad = document.getElementById('imgUrlLoad');
  const imgRemote = document.getElementById('imgRemote');
  const imgPreviewPane = document.getElementById('imgPreviewPane');
  const imgCanvasWrap = document.getElementById('imgCanvasWrap');
  const imgCropTarget = document.getElementById('imgCropTarget');
  const imgPreview = document.getElementById('imgPreview');
  const imgCropTools = document.getElementById('imgCropTools');
  const imgCropHint = document.getElementById('imgCropHint');
  const imgRasterControls = document.getElementById('imgRasterControls');
  const imgFormat = document.getElementById('imgFormat');
  const imgMaxWidth = document.getElementById('imgMaxWidth');
  const imgMaxWidthVal = document.getElementById('imgMaxWidthVal');
  const imgQuality = document.getElementById('imgQuality');
  const imgQualityVal = document.getElementById('imgQualityVal');
  const imgResetCrop = document.getElementById('imgResetCrop');
  const imgFileName = document.getElementById('imgFileName');
  const imgAlt = document.getElementById('imgAlt');
  const imgWidth = document.getElementById('imgWidth');
  const imgHeight = document.getElementById('imgHeight');
  const imgLinkDims = document.getElementById('imgLinkDims');
  const imgSubfolder = document.getElementById('imgSubfolder');
  const imgSubfolderLabel = document.getElementById('imgSubfolderLabel');
  const imgErrorEl = document.getElementById('imgError');
  const imgCancel = document.getElementById('imgCancel');
  const imgSave = document.getElementById('imgSave');
  const imgBusy = document.getElementById('imgBusy');
  const imgBusyText = document.getElementById('imgBusyText');

  let imgCropper = null;
  let imgIsSvg = false;
  let imgSvgDataUrl = null;
  let imgIsEdit = false;
  let imgEditSrc = '';
  let imgHasSource = false;
  let imgDirty = false;
  // Width/height fields auto-track the cropped output until the user edits them.
  let imgDimsAuto = true;
  let imgLockedAspect = 0;
  // Pristine source for caching, and a crop rect to restore from the cache.
  let imgSourceDataUrl = null;
  let imgPendingCrop = null;
  let imgBusyCount = 0;

  // Pixel size the saved image will actually have: the crop size, capped by the
  // max-width slider only when the bytes are re-encoded (dirty). When unchanged,
  // the original bytes are kept, so the natural crop size is used uncapped.
  function imgOutputSize() {
    if (!imgCropper) return null;
    let d;
    try { d = imgCropper.getData(true); } catch (e) { return null; }
    const cw = Math.max(1, Math.round(d.width));
    const ch = Math.max(1, Math.round(d.height));
    if (!imgDirty) return { w: cw, h: ch };
    const maxW = parseInt(imgMaxWidth.value, 10);
    const scale = Math.min(1, maxW / cw);
    return { w: Math.max(1, Math.round(cw * scale)), h: Math.max(1, Math.round(ch * scale)) };
  }
  function imgRefreshAutoDims() {
    if (!imgDimsAuto) return;
    const s = imgOutputSize();
    if (!s) return;
    imgWidth.value = String(s.w);
    imgHeight.value = String(s.h);
    imgLockedAspect = s.w / s.h;
  }
  function imgDimsPayload() {
    const w = parseInt(imgWidth.value, 10);
    const h = parseInt(imgHeight.value, 10);
    return {
      width: w > 0 ? w : undefined,
      height: h > 0 ? h : undefined,
    };
  }
  // Pristine source + settings sent with file saves so the original can be
  // cached and re-loaded later for crop/quality changes.
  function imgCachePayload() {
    const p = {
      originalDataUrl: imgSourceDataUrl || undefined,
      maxWidth: parseInt(imgMaxWidth.value, 10),
      quality: parseInt(imgQuality.value, 10),
      format: imgFormat.value,
    };
    if (imgCropper) {
      try {
        const d = imgCropper.getData(true);
        p.crop = { x: d.x, y: d.y, width: d.width, height: d.height, rotate: d.rotate, scaleX: d.scaleX, scaleY: d.scaleY };
      } catch (e) { /* no crop available */ }
    }
    return p;
  }

  function imgDestroyCropper() {
    if (imgCropper) { imgCropper.destroy(); imgCropper = null; }
    imgCropTarget.removeAttribute('src');
    imgCropTarget.style.display = 'none';
    imgCanvasWrap.classList.remove('cropping');
  }
  function imgSetActiveAspect(btn) {
    const btns = imgCropTools.querySelectorAll('.aspect-btn');
    for (let i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('is-active', btns[i] === btn);
    }
  }

  function imgSlug(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function imgSetError(msg) {
    imgErrorEl.hidden = !msg;
    imgErrorEl.textContent = msg || '';
  }
  function imgSetBusy(active, text) {
    imgBusyCount = Math.max(0, imgBusyCount + (active ? 1 : -1));
    imgBusy.hidden = imgBusyCount === 0;
    if (text) imgBusyText.textContent = text;
  }
  function imgResetSaveBtn() {
    imgSave.disabled = false;
    imgSave.textContent = imgIsEdit ? 'Save' : 'Insert image';
  }

  function imgShow() {
    builder.hidden = true;
    closeBuilder();
    imageBuilder.hidden = false;
  }
  function imgClose() {
    imageBuilder.hidden = true;
    imgIsEdit = false;
  }

  function imgResetState() {
    imgDestroyCropper();
    imgIsSvg = false;
    imgSvgDataUrl = null;
    imgHasSource = false;
    imgDirty = false;
    imgDimsAuto = true;
    imgLockedAspect = 0;
    imgWidth.value = '';
    imgHeight.value = '';
    imgLinkDims.checked = true;
    imgSourceDataUrl = null;
    imgPendingCrop = null;
    imgBusyCount = 0;
    imgBusy.hidden = true;
    imgSetError('');
    imgPreviewPane.hidden = true;
    imgCropHint.hidden = true;
    imgCropTools.hidden = true;
    imgRasterControls.hidden = true;
    imgPreview.hidden = true;
    imgPreview.removeAttribute('src');
    imgRemote.checked = false;
    imgUrl.value = '';
  }

  function imgApplyRemoteMode() {
    const remote = imgRemote.checked;
    imgSubfolderLabel.style.display = remote ? 'none' : '';
    if (remote) {
      imgDestroyCropper();
      imgRasterControls.hidden = true;
      imgCropHint.hidden = true;
      imgCropTools.hidden = true;
      imgFileName.parentElement.style.display = 'none';
      if (imgUrl.value.trim()) {
        imgPreview.src = imgUrl.value.trim();
        imgPreview.hidden = false;
        imgPreviewPane.hidden = false;
      }
    } else {
      imgFileName.parentElement.style.display = '';
      if (imgHasSource && !imgIsSvg) {
        imgRasterControls.hidden = false;
        imgCropHint.hidden = false;
        imgCropTools.hidden = false;
      }
    }
  }

  imgCropTools.addEventListener('click', function (e) {
    const btn = e.target && e.target.closest ? e.target.closest('.aspect-btn') : null;
    if (!btn || !imgCropper) return;
    const r = btn.getAttribute('data-ratio');
    imgCropper.setAspectRatio(r === 'free' ? NaN : parseFloat(r));
    imgSetActiveAspect(btn);
    imgDirty = true;
    imgRefreshAutoDims();
    setTimeout(imgLiveApply, 0);
  });

  // Produce the cropped + resized data URL via Cropper, honoring max width,
  // format, and quality. SVGs are passed through untouched.
  function imgExport(cb) {
    if (imgIsSvg) return cb(imgSvgDataUrl);
    if (!imgCropper) return cb(null);
    const maxW = parseInt(imgMaxWidth.value, 10);
    const canvas = imgCropper.getCroppedCanvas({
      maxWidth: maxW,
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
    });
    if (!canvas) return cb(null);
    const mime = imgFormat.value;
    const q = parseInt(imgQuality.value, 10) / 100;
    try {
      cb(mime === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL(mime, q));
    } catch (err) {
      cb(null);
    }
  }

  function imgBuildPayload(cb) {
    imgSetError('');
    if (imgRemote.checked) {
      const url = imgUrl.value.trim();
      if (!url) { imgSetError('Enter an image URL.'); cb(null); return; }
      cb(Object.assign({ mode: 'url', url: url, alt: imgAlt.value.trim(), fileName: '', subfolder: '' }, imgDimsPayload()));
      return;
    }
    if (imgHasSource && imgDirty) {
      imgSetBusy(true, 'Compressing…');
      imgExport(function (dataUrl) {
        imgSetBusy(false);
        if (!dataUrl) { imgSetError('Could not process the image.'); cb(null); return; }
        cb(Object.assign({
          mode: 'file', dataUrl: dataUrl,
          fileName: imgFileName.value.trim() || 'image',
          subfolder: imgSubfolder.value.trim() || 'images',
          alt: imgAlt.value.trim(), keepSrc: imgEditSrc, dirty: true,
        }, imgDimsPayload(), imgCachePayload()));
      });
      return;
    }
    if (imgIsEdit && imgEditSrc) {
      cb(Object.assign({
        mode: 'file', keepSrc: imgEditSrc, dirty: false,
        fileName: imgFileName.value.trim() || 'image',
        subfolder: imgSubfolder.value.trim() || 'images',
        alt: imgAlt.value.trim(),
      }, imgDimsPayload(), imgCachePayload()));
      return;
    }
    imgSetError('Add an image first — drop a file, browse, or paste a URL.');
    cb(null);
  }

  function imgLiveApply() {
    if (!imgIsEdit) return;
    imgBuildPayload(function (payload) {
      if (!payload) return;
      imgSetBusy(true, 'Applying…');
      vscode.postMessage({ type: 'imageLiveApply', payload: payload });
    });
  }

  // Load a source image (drop / pick / fetched URL). keepMeta=true preserves
  // the file name + alt fields (used when re-loading an existing image to edit).
  function imgLoadSource(dataUrl, name, keepMeta) {
    imgSetError('');
    imgDestroyCropper();
    imgHasSource = true;
    imgSourceDataUrl = dataUrl;
    imgIsSvg = String(dataUrl).indexOf('image/svg') !== -1;
    if (!keepMeta) {
      imgFileName.value = imgSlug(name) || 'image';
      if (!imgAlt.value.trim()) imgAlt.value = (name || 'image').replace(/-/g, ' ');
      imgDirty = true;
    }
    imgPreviewPane.hidden = false;
    if (imgIsSvg) {
      imgSvgDataUrl = dataUrl;
      imgPreview.src = dataUrl;
      imgPreview.hidden = false;
      imgRasterControls.hidden = true;
      imgCropHint.hidden = true;
      imgCropTools.hidden = true;
      return;
    }
    if (imgRemote.checked) { imgApplyRemoteMode(); return; }
    const freeBtn = imgCropTools.querySelector('.aspect-btn[data-ratio="free"]');
    if (freeBtn) imgSetActiveAspect(freeBtn);
    imgPreview.hidden = true;
    imgCanvasWrap.classList.add('cropping');
    imgCropTarget.style.display = 'block';
    imgCropTarget.onload = function () {
      imgCropTarget.onload = null;
      imgCropper = new Cropper(imgCropTarget, {
        viewMode: 1,
        autoCropArea: 1,
        background: false,
        responsive: true,
        checkOrientation: false,
        ready: function () {
          imgRasterControls.hidden = false;
          imgCropHint.hidden = false;
          imgCropTools.hidden = false;
          if (imgPendingCrop) {
            try { imgCropper.setData(imgPendingCrop); } catch (e) { /* ignore */ }
            imgPendingCrop = null;
          }
          imgRefreshAutoDims();
        },
        cropend: function () { imgDirty = true; imgRefreshAutoDims(); imgLiveApply(); },
      });
    };
    imgCropTarget.onerror = function () { imgSetError('Failed to load image.'); };
    imgCropTarget.src = dataUrl;
  }

  function imgOpenInsert() {
    imgIsEdit = false;
    imgEditSrc = '';
    imgResetState();
    imgTitle.textContent = 'Add image';
    imgDesc.textContent = 'Drop an image, browse your computer, or paste a URL. Crop and optimize before it lands next to your MDX file.';
    imgFileName.value = 'image';
    imgAlt.value = '';
    imgSubfolder.value = 'images';
    imgFileName.parentElement.style.display = '';
    imgSubfolderLabel.style.display = '';
    imgResetSaveBtn();
    imgShow();
  }

  function imgOpenEdit(data) {
    imgIsEdit = true;
    imgEditSrc = data.src || '';
    imgResetState();
    imgTitle.textContent = 'Edit image';
    imgDesc.textContent = 'Update the alt text, re-crop, or replace this image.';
    imgAlt.value = data.alt || '';
    // Prefill width/height from the existing tag. Keep auto-tracking enabled so
    // crop/max-width changes update these fields until the user edits them.
    if (data.width) imgWidth.value = String(data.width);
    if (data.height) imgHeight.value = String(data.height);
    if (data.width && data.height) {
      imgLockedAspect = parseInt(data.width, 10) / parseInt(data.height, 10);
    }
    // Derive file name + subfolder from the existing src.
    let s = imgEditSrc;
    const isRemote = /^https?:\\/\\//i.test(s);
    if (isRemote) {
      imgRemote.checked = true;
      imgUrl.value = s;
      imgApplyRemoteMode();
      imgResetSaveBtn();
      imgShow();
      return;
    }
    if (s.indexOf('./') === 0) s = s.slice(2);
    const parts = s.split('/');
    let fname = parts.pop() || 'image';
    const dot = fname.lastIndexOf('.');
    if (dot > 0) fname = fname.slice(0, dot);
    imgFileName.value = fname;
    imgSubfolder.value = parts.join('/') || 'images';
    imgFileName.parentElement.style.display = '';
    imgSubfolderLabel.style.display = '';
    // Replay cached export settings so quality/crop can be tweaked from the
    // pristine original rather than the already-compressed file on disk.
    if (data.cache) {
      if (data.cache.maxWidth) { imgMaxWidth.value = String(data.cache.maxWidth); imgMaxWidthVal.textContent = imgMaxWidth.value; }
      if (data.cache.quality) { imgQuality.value = String(data.cache.quality); imgQualityVal.textContent = imgQuality.value + '%'; }
      if (data.cache.format) imgFormat.value = data.cache.format;
      if (data.cache.crop) imgPendingCrop = data.cache.crop;
    }
    if (data.dataUrl) {
      imgLoadSource(data.dataUrl, fname, true);
      imgDirty = false;
    } else {
      imgSetError('Could not load the current image file — you can still edit alt text or replace it.');
    }
    imgResetSaveBtn();
    imgShow();
  }

  function imgDoSave() {
    imgBuildPayload(function (payload) {
      if (!payload) return;
      imgSave.disabled = true;
      imgSave.textContent = 'Saving…';
      vscode.postMessage({ type: 'imageInsert', payload: payload });
    });
  }

  imgDrop.addEventListener('click', function () { vscode.postMessage({ type: 'imagePickFile' }); });
  imgDrop.addEventListener('dragover', function (e) { e.preventDefault(); imgDrop.classList.add('drag'); });
  imgDrop.addEventListener('dragleave', function () { imgDrop.classList.remove('drag'); });
  imgDrop.addEventListener('drop', function (e) {
    e.preventDefault();
    imgDrop.classList.remove('drag');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = function () { imgLoadSource(reader.result, f.name.replace(/\\.[^.]+$/, ''), false); };
    reader.readAsDataURL(f);
  });
  imgUrlLoad.addEventListener('click', function () {
    const url = imgUrl.value.trim();
    if (!url) { imgSetError('Enter an image URL.'); return; }
    if (imgRemote.checked) { imgApplyRemoteMode(); return; }
    imgUrlLoad.disabled = true;
    imgUrlLoad.textContent = '…';
    vscode.postMessage({ type: 'imageFetchUrl', url: url });
  });
  imgRemote.addEventListener('change', function () { imgApplyRemoteMode(); imgLiveApply(); });
  imgMaxWidth.addEventListener('input', function () { imgMaxWidthVal.textContent = imgMaxWidth.value; imgDirty = true; imgRefreshAutoDims(); });
  imgMaxWidth.addEventListener('change', imgLiveApply);
  imgQuality.addEventListener('input', function () { imgQualityVal.textContent = imgQuality.value + '%'; imgDirty = true; });
  imgQuality.addEventListener('change', imgLiveApply);
  imgFormat.addEventListener('change', function () { imgDirty = true; imgLiveApply(); });
  imgResetCrop.addEventListener('click', function () {
    if (imgCropper) imgCropper.reset();
    const freeBtn = imgCropTools.querySelector('.aspect-btn[data-ratio="free"]');
    if (freeBtn) { imgCropper && imgCropper.setAspectRatio(NaN); imgSetActiveAspect(freeBtn); }
    imgDirty = true;
    imgDimsAuto = true;
    imgRefreshAutoDims();
    imgLiveApply();
  });

  imgWidth.addEventListener('input', function () {
    imgDimsAuto = false;
    if (imgLinkDims.checked && imgLockedAspect > 0) {
      const w = parseInt(imgWidth.value, 10);
      if (w > 0) imgHeight.value = String(Math.max(1, Math.round(w / imgLockedAspect)));
    }
  });
  imgHeight.addEventListener('input', function () {
    imgDimsAuto = false;
    if (imgLinkDims.checked && imgLockedAspect > 0) {
      const h = parseInt(imgHeight.value, 10);
      if (h > 0) imgWidth.value = String(Math.max(1, Math.round(h * imgLockedAspect)));
    }
  });
  imgWidth.addEventListener('change', imgLiveApply);
  imgHeight.addEventListener('change', imgLiveApply);
  imgAlt.addEventListener('change', imgLiveApply);
  imgLinkDims.addEventListener('change', function () {
    const w = parseInt(imgWidth.value, 10);
    const h = parseInt(imgHeight.value, 10);
    if (imgLinkDims.checked && w > 0 && h > 0) imgLockedAspect = w / h;
    imgLiveApply();
  });
  imgCancel.addEventListener('click', function () { vscode.postMessage({ type: 'imageCancel' }); imgClose(); });
  imgSave.addEventListener('click', imgDoSave);

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg.type === 'state') applyState(msg);
    if (msg.type === 'openBuilder') openBuilder(msg.id);
    if (msg.type === 'editBuilder') openBuilderEdit(msg.id, msg.text);
    if (msg.type === 'openImage') imgOpenInsert();
    if (msg.type === 'editImage') imgOpenEdit(msg.data || {});
    if (msg.type === 'imageLoaded') {
      imgUrlLoad.disabled = false;
      imgUrlLoad.textContent = 'Load';
      imgLoadSource(msg.dataUrl, msg.name, false);
    }
    if (msg.type === 'imageError') {
      imgUrlLoad.disabled = false;
      imgUrlLoad.textContent = 'Load';
      imgSetBusy(false);
      imgResetSaveBtn();
      imgSetError(msg.message || 'Something went wrong.');
    }
    if (msg.type === 'imageApplied') {
      imgSetBusy(false);
      if (msg.src) imgEditSrc = msg.src;
    }
    if (msg.type === 'imageDone') imgClose();
  });

  vscode.postMessage({ type: 'refresh' });
})();
</script>
</body>
</html>`;
}
