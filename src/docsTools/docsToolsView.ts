import * as vscode from "vscode";
import { FUMADOCS_COMPONENTS, getComponent } from "./componentSnippets";
import { openAddImageFlow } from "./imageDialog";
import { insertBlockBelowCursor } from "./insertAtCursor";
import { getDocsToolsContext } from "./state";

/** The component block currently being built/edited live in the document. */
interface ComponentSession {
  uri: vscode.Uri;
  /** Current span of the block in the document, kept in sync on every apply. */
  range: vscode.Range;
  mode: "edit" | "insert";
  /** Original block text for edit-mode revert; null for insert mode. */
  originalText: string | null;
}

export class DocsToolsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "fumadocs.docsTools";

  private view: vscode.WebviewView | undefined;
  private pendingBuilderId: string | undefined;
  private pendingEdit: { id: string; text: string } | undefined;
  /** Live-edit session for the component currently open in the builder. */
  private session: ComponentSession | undefined;
  /** Editor captured when an insert-mode builder opens (before the block exists). */
  private pendingInsertEditor: vscode.TextEditor | undefined;
  /** Serializes document edits so debounced applies never interleave. */
  private queue: Promise<void> = Promise.resolve();

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
    webviewView.webview.html = sidebarHtml();

    webviewView.webview.onDidReceiveMessage(
      (msg: { type?: string; id?: string; text?: string; mode?: string }) => {
        if (msg.type === "addImage") void openAddImageFlow();
        if (msg.type === "insertComponent" && msg.id) void insertComponent(msg.id);
        if (msg.type === "liveApply" && typeof msg.text === "string") {
          this.enqueueLiveApply(msg.text, msg.mode === "edit" ? "edit" : "insert");
        }
        if (msg.type === "cancelEdit") this.enqueueCancel();
        if (msg.type === "finishEdit") this.enqueueFinish();
        if (msg.type === "refresh") {
          this.pushState();
          this.flushBuilder();
        }
      },
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
      await replaceRange(session.uri, session.range, session.originalText);
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
): Promise<vscode.Range | null> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, range, text);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) return null;

  const lines = text.split("\n");
  const endLine = range.start.line + lines.length - 1;
  const endChar =
    lines.length === 1
      ? range.start.character + lines[0].length
      : (lines.at(-1) ?? "").length;
  return new vscode.Range(range.start, new vscode.Position(endLine, endChar));
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
  const provider = new DocsToolsViewProvider();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DocsToolsViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand("fumadocs.docsTools.addImage", () =>
      openAddImageFlow(),
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

function sidebarHtml(): string {
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
  ].join("; ");

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
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
</style>
</head>
<body>
  <div class="root" id="root">
    <section>
      <h2 class="section-title">Content source</h2>
      <p class="status" id="status">Waiting for editor…</p>
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

<script>
(function () {
  const vscode = acquireVsCodeApi();
  const statusEl = document.getElementById('status');
  const addImageBtn = document.getElementById('addImageBtn');
  const toolsNote = document.getElementById('toolsNote');
  const componentsEl = document.getElementById('components');

  const builder = document.getElementById('builder');
  const builderTitle = document.getElementById('builderTitle');
  const builderDesc = document.getElementById('builderDesc');
  const builderForm = document.getElementById('builderForm');
  const builderRender = document.getElementById('builderRender');
  const builderInsert = document.getElementById('builderInsert');
  const builderCancel = document.getElementById('builderCancel');

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
  };

  let activeDef = null;
  let editing = false;
  let state = { scalars: {}, lists: {} };
  // Transient interaction state for the live preview (active tab, open rows…).
  let previewUi = { tab: 0, codeTab: 0, open: { 0: true } };

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function collect() {
    const v = {};
    for (const k in state.scalars) v[k] = state.scalars[k];
    for (const k in state.lists) v[k] = state.lists[k];
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
  }

  // Seed builder state from defaults, overlaying any parsed initial values.
  function seedState(def, initial) {
    state = { scalars: {}, lists: {} };
    for (const field of def.fields) {
      state.scalars[field.key] =
        initial && initial[field.key] != null ? initial[field.key] : field.default;
    }
    for (const listDef of def.lists) {
      const v = initial && initial[listDef.key];
      state.lists[listDef.key] =
        Array.isArray(v) && v.length ? clone(v) : clone(listDef.default);
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
    toolsNote.hidden = enabledState;
    // Keep an in-progress edit open even if the active editor briefly changes.
    if (!enabledState && !editing) closeBuilder();

    if (enabledState) {
      statusEl.className = 'status active';
      statusEl.innerHTML =
        '<strong>Active file</strong>' + basename(ctx.filePath) +
        '<strong style="margin-top:6px">Content root</strong>' + ctx.contentRoot;
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

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg.type === 'state') applyState(msg);
    if (msg.type === 'openBuilder') openBuilder(msg.id);
    if (msg.type === 'editBuilder') openBuilderEdit(msg.id, msg.text);
  });

  vscode.postMessage({ type: 'refresh' });
})();
</script>
</body>
</html>`;
}
