import * as vscode from "vscode";

/**
 * A single reusable side-by-side webview that embeds the running Fumadocs
 * preview server in an iframe.
 */
export class PreviewPanel {
  private static current: PreviewPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private onDisposeCb: (() => void) | undefined;
  private currentUrl = "";

  static get currentUrl(): string | undefined {
    return PreviewPanel.current?.currentUrl || undefined;
  }

  static createOrShow(): PreviewPanel {
    if (PreviewPanel.current) {
      PreviewPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
      return PreviewPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      "fumadocs.preview",
      "Fumadocs Preview",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );
    PreviewPanel.current = new PreviewPanel(panel);
    void vscode.commands.executeCommand("setContext", "fumadocs.previewActive", true);
    return PreviewPanel.current;
  }

  static get exists(): boolean {
    return PreviewPanel.current !== undefined;
  }

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.webview.html = this.shellHtml();
    this.panel.webview.onDidReceiveMessage(
      (msg: { type?: string }) => {
        if (msg.type === "openExternal") {
          const url = PreviewPanel.currentUrl;
          if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
        }
      },
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  onDidDispose(cb: () => void): void {
    this.onDisposeCb = cb;
  }

  /** Point the iframe at `baseUrl + slugPath`, optionally setting the title. */
  navigate(baseUrl: string, slugPath: string, title?: string): void {
    const url = `${baseUrl}${slugPath}`;
    this.currentUrl = url;
    if (title) this.panel.title = `Preview: ${title}`;
    void this.panel.webview.postMessage({ type: "navigate", url });
  }

  /** Force the iframe to reload its current page (after a save). */
  reload(): void {
    void this.panel.webview.postMessage({ type: "reload" });
  }

  /** Show the in-progress view: which route is loading and the current phase. */
  showProgress(route: string, phase: string): void {
    void this.panel.webview.postMessage({ type: "progress", route, phase });
  }

  /** Show a failure with a collapsible dropdown of debugging logs. */
  showError(route: string, message: string, logs: string): void {
    void this.panel.webview.postMessage({ type: "error", route, message, logs });
  }

  private shellHtml(): string {
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "script-src 'unsafe-inline'",
      "frame-src http://127.0.0.1:* http://localhost:*",
      "img-src http://127.0.0.1:* http://localhost:* data:",
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  html, body { height: 100%; margin: 0; padding: 0; background: var(--vscode-editor-background); }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    display: flex;
    flex-direction: column;
  }
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    flex-shrink: 0;
  }
  .toolbar-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
  }
  .toolbar-actions { display: flex; align-items: center; gap: 8px; }
  .toolbar-btn {
    appearance: none;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 4px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    padding: 7px 12px;
  }
  .toolbar-btn:hover {
    background: var(--vscode-button-hoverBackground);
  }
  .toolbar-btn:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }
  .preview-shell {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .overlay {
    display: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    padding: 24px;
    text-align: center;
    position: absolute;
    inset: 0;
  }
  .overlay.visible { display: flex; }
  .spinner {
    width: 22px; height: 22px; margin-bottom: 14px;
    border: 2px solid var(--vscode-descriptionForeground);
    border-top-color: transparent; border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .route {
    font-size: 12px; opacity: 0.8; margin-bottom: 4px;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  #progress .phase { font-size: 13px; color: var(--vscode-descriptionForeground); }

  #error { color: var(--vscode-foreground); }
  #error .badge {
    color: var(--vscode-errorForeground); font-weight: 600; font-size: 13px; margin-bottom: 8px;
  }
  #error .message {
    max-width: 560px; font-size: 13px; line-height: 1.5; margin-bottom: 16px;
    white-space: pre-wrap; word-break: break-word;
  }
  #error details {
    width: 100%; max-width: 720px; text-align: left;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    border-radius: 6px; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
  }
  #error summary {
    cursor: pointer; user-select: none; padding: 8px 12px; font-size: 12px;
    color: var(--vscode-descriptionForeground); outline: none;
  }
  #error summary:hover { color: var(--vscode-foreground); }
  #error pre {
    margin: 0; padding: 12px; max-height: 320px; overflow: auto;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
    color: var(--vscode-descriptionForeground);
  }
  #error .empty-logs { padding: 12px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  iframe {
    border: 0;
    width: 100%;
    height: 100%;
    display: none;
    background: #fff;
    position: absolute;
    inset: 0;
  }
</style>
</head>
<body>
  <div class="toolbar">
    <span class="toolbar-label">Fumadocs Preview</span>
    <div class="toolbar-actions">
      <button class="toolbar-btn" id="open-browser" type="button" title="Open this page in your default browser">
        Open in Browser ↗
      </button>
    </div>
  </div>

  <div class="preview-shell">
  <div id="progress" class="overlay visible">
    <div class="spinner"></div>
    <div class="route" id="progress-route">&nbsp;</div>
    <div class="phase" id="progress-phase">Starting Fumadocs preview…</div>
  </div>

  <div id="error" class="overlay">
    <div class="badge">Fumadocs preview failed</div>
    <div class="route" id="error-route">&nbsp;</div>
    <div class="message" id="error-message"></div>
    <details>
      <summary>Show debugging logs</summary>
      <pre id="error-logs"></pre>
    </details>
  </div>

  <iframe id="frame" title="Fumadocs Preview"></iframe>
  </div>
  <script>
    const vscodeApi = acquireVsCodeApi();
    const frame = document.getElementById('frame');
    const openBrowserBtn = document.getElementById('open-browser');
    const progress = document.getElementById('progress');
    const progressRoute = document.getElementById('progress-route');
    const progressPhase = document.getElementById('progress-phase');
    const errorBox = document.getElementById('error');
    const errorRoute = document.getElementById('error-route');
    const errorMessage = document.getElementById('error-message');
    const errorLogs = document.getElementById('error-logs');
    let currentUrl = '';

    function showFrame(url) {
      currentUrl = url;
      frame.src = url;
      frame.style.display = 'block';
      progress.classList.remove('visible');
      errorBox.classList.remove('visible');
    }

    function showProgress(route, phase) {
      progressRoute.textContent = route ? 'Route: ' + route : '';
      progressPhase.textContent = phase || 'Starting Fumadocs preview…';
      errorBox.classList.remove('visible');
      frame.style.display = 'none';
      progress.classList.add('visible');
    }

    function showError(route, message, logs) {
      errorRoute.textContent = route ? 'Route: ' + route : '';
      errorMessage.textContent = message || 'Unknown error.';
      errorLogs.textContent = logs && logs.trim().length
        ? logs
        : 'No logs were captured.';
      progress.classList.remove('visible');
      frame.style.display = 'none';
      errorBox.classList.add('visible');
    }

    function withNonce(url) {
      const u = new URL(url);
      u.searchParams.set('__fd', String(Date.now()));
      return u.toString();
    }

    openBrowserBtn.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'openExternal' });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'navigate') {
        // Always bust the cache so the renderer re-reads the active root and
        // the iframe reloads even when two roots share the same slug.
        showFrame(withNonce(msg.url));
      } else if (msg.type === 'reload') {
        if (!currentUrl) return;
        frame.src = withNonce(currentUrl);
      } else if (msg.type === 'progress') {
        showProgress(msg.route, msg.phase);
      } else if (msg.type === 'error') {
        showError(msg.route, msg.message, msg.logs);
      }
    });
  </script>
</body>
</html>`;
  }

  private dispose(): void {
    PreviewPanel.current = undefined;
    void vscode.commands.executeCommand("setContext", "fumadocs.previewActive", false);
    this.onDisposeCb?.();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    this.panel.dispose();
  }
}
