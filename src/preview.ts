import * as vscode from "vscode";
import * as path from "node:path";
import { renderMdx, addChildToContainer } from "./render/mdxToHtml";

interface ReplaceMessage {
  type: "live" | "apply";
  start: number;
  end: number;
  text: string;
}

interface AddItemMessage {
  type: "addItem";
  start: number;
  end: number;
  name: string;
}

interface LifecycleMessage {
  type: "editStart" | "editEnd";
}

type WebviewMessage = ReplaceMessage | AddItemMessage | LifecycleMessage;

const isPreviewable = (document: vscode.TextDocument): boolean =>
  document.languageId === "mdx" ||
  document.languageId === "markdown" ||
  document.fileName.endsWith(".mdx");

const nonce = (): string => {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
};

class PreviewManager {
  private panel: vscode.WebviewPanel | undefined;
  private trackedUri: vscode.Uri | undefined;
  private debounce: NodeJS.Timeout | undefined;
  /** True while an inline editor is open in the webview; blocks all re-renders. */
  private editing = false;
  /** The webview shell is only written once; updates are patched in place. */
  private initialized = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  open(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isPreviewable(editor.document)) {
      void vscode.window.showWarningMessage(
        "Open an MDX or Markdown file to preview it.",
      );
      return;
    }

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        "fumadocsPreview",
        "Fumadocs Preview",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: this.resourceRoots(editor.document.uri),
        },
      );

      this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
      this.panel.webview.onDidReceiveMessage(
        (message: WebviewMessage) => this.handleMessage(message),
        null,
        this.disposables,
      );
      this.registerListeners();
    }

    this.track(editor.document);
  }

  private get trackedDocument(): vscode.TextDocument | undefined {
    if (!this.trackedUri) {
      return undefined;
    }
    return vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === this.trackedUri?.toString(),
    );
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    const document = this.trackedDocument;
    if (!document) {
      return;
    }

    if (message.type === "editStart") {
      // Lock rendering so the open inline editor is never clobbered.
      this.editing = true;
      if (this.debounce) {
        clearTimeout(this.debounce);
        this.debounce = undefined;
      }
      return;
    }

    if (message.type === "editEnd") {
      this.editing = false;
      this.render(document);
      return;
    }

    if (message.type === "addItem") {
      await this.addItem(document, message);
      return;
    }

    if (message.type === "live" || message.type === "apply") {
      const range = new vscode.Range(
        document.positionAt(message.start),
        document.positionAt(message.end),
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, range, message.text);
      await vscode.workspace.applyEdit(edit);
      // "live" edits keep the in-place textarea open, so we never re-render here
      // (the editing lock already blocks the resulting document-change render).
      if (message.type === "apply") {
        this.render(document);
      }
    }
  }

  private async addItem(
    document: vscode.TextDocument,
    message: AddItemMessage,
  ): Promise<void> {
    const range = new vscode.Range(
      document.positionAt(message.start),
      document.positionAt(message.end),
    );
    const source = document.getText(range);
    const updated = addChildToContainer(source, message.name);
    if (updated === null) {
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, range, updated);
    await vscode.workspace.applyEdit(edit);
    this.render(document);
  }

  private resourceRoots(docUri: vscode.Uri): vscode.Uri[] {
    const roots = [vscode.Uri.joinPath(this.extensionUri, "media")];
    const folder = vscode.Uri.file(path.dirname(docUri.fsPath));
    roots.push(folder);
    const workspace = vscode.workspace.getWorkspaceFolder(docUri);
    if (workspace) {
      roots.push(workspace.uri);
    }
    return roots;
  }

  private registerListeners(): void {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (
          !this.trackedUri ||
          event.document.uri.toString() !== this.trackedUri.toString()
        ) {
          return;
        }
        // While an inline editor is open, the webview owns the document; don't
        // re-render or we'd discard the editor and the user's focus/caret.
        if (this.editing) {
          return;
        }
        this.scheduleRender(event.document);
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        // Don't switch the tracked document out from under an open inline editor.
        if (!this.editing && editor && isPreviewable(editor.document)) {
          this.track(editor.document);
        }
      }),
    );
  }

  private track(document: vscode.TextDocument): void {
    // Switching to a different file needs a fresh shell (resource roots change).
    if (this.trackedUri?.toString() !== document.uri.toString()) {
      this.initialized = false;
    }
    this.trackedUri = document.uri;
    if (this.panel) {
      this.panel.title = `Preview: ${path.basename(document.fileName)}`;
      this.panel.webview.options = {
        enableScripts: true,
        localResourceRoots: this.resourceRoots(document.uri),
      };
    }
    this.render(document);
  }

  private scheduleRender(document: vscode.TextDocument): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    this.debounce = setTimeout(() => this.render(document), 150);
  }

  private render(document: vscode.TextDocument): void {
    if (!this.panel || this.editing) {
      return;
    }

    const webview = this.panel.webview;
    const docDir = path.dirname(document.uri.fsPath);

    const resolveImage = (src: string): string => {
      if (/^(https?:)?\/\//.test(src) || src.startsWith("data:")) {
        return src;
      }
      const target = path.isAbsolute(src)
        ? src
        : path.resolve(docDir, src.replace(/^\.\//, ""));
      return webview.asWebviewUri(vscode.Uri.file(target)).toString();
    };

    const { html } = renderMdx(document.getText(), resolveImage);

    if (this.initialized) {
      // Patch the content in place so the webview never reloads (keeps scroll,
      // focus, and client state intact).
      void this.panel.webview.postMessage({ type: "update", html });
    } else {
      this.panel.webview.html = this.wrap(webview, html);
      this.initialized = true;
    }
  }

  private wrap(webview: vscode.Webview, bodyHtml: string): string {
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "preview.css"),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "preview.js"),
    );
    const cspSource = webview.cspSource;
    const n = nonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${n}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${cssUri}" rel="stylesheet" />
  <title>Fumadocs Preview</title>
</head>
<body>
  <div class="fd-preview-banner">Click any block to edit it. Use the buttons to convert Markdown to components or add more items.</div>
  <article class="fd-content">
    ${bodyHtml}
  </article>
  <script nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.panel = undefined;
    this.trackedUri = undefined;
    this.editing = false;
    this.initialized = false;
  }
}

let manager: PreviewManager | undefined;

export const openPreview = (extensionUri: vscode.Uri): void => {
  if (!manager) {
    manager = new PreviewManager(extensionUri);
  }
  manager.open();
};
