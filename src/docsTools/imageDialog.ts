import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getDocsToolsContext } from "./state";
import { imageMarkup, insertBlockBelowCursor } from "./insertAtCursor";

export interface ImageSavePayload {
  dataUrl: string;
  fileName: string;
  alt: string;
  subfolder: string;
}

/**
 * Opens a native file picker, then a crop/optimize webview to save and insert.
 */
export async function openAddImageFlow(): Promise<void> {
  const ctx = getDocsToolsContext();
  if (!ctx.enabled || !ctx.filePath) {
    void vscode.window.showWarningMessage(ctx.reason || "Docs tools are not available.");
    return;
  }

  const picks = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Select image",
    filters: {
      Images: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"],
    },
  });
  if (!picks?.length) return;

  const sourcePath = picks[0].fsPath;
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext === ".svg") {
    await saveSvgAndInsert(sourcePath, ctx.filePath);
    return;
  }

  const buffer = fs.readFileSync(sourcePath);
  const mime = mimeForExt(ext);
  const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
  const defaultName = slugify(path.basename(sourcePath, ext)) || "image";

  ImageDialogPanel.show(dataUrl, defaultName, async (payload) => {
    await saveOptimizedImage(payload, ctx.filePath!);
  });
}

async function saveSvgAndInsert(
  sourcePath: string,
  currentFilePath: string,
): Promise<void> {
  const fileDir = path.dirname(currentFilePath);
  const imagesDir = path.join(fileDir, "images");
  fs.mkdirSync(imagesDir, { recursive: true });

  const base = slugify(path.basename(sourcePath, path.extname(sourcePath))) || "image";
  let destName = `${base}.svg`;
  let destPath = path.join(imagesDir, destName);
  let n = 1;
  while (fs.existsSync(destPath)) {
    destName = `${base}-${n}.svg`;
    destPath = path.join(imagesDir, destName);
    n++;
  }

  fs.copyFileSync(sourcePath, destPath);
  const rel = `./images/${destName}`;
  const alt = base.replace(/-/g, " ");
  await insertBlockBelowCursor(imageMarkup(rel, alt));
  void vscode.window.showInformationMessage(`Image saved as ${rel}`);
}

async function saveOptimizedImage(
  payload: ImageSavePayload,
  currentFilePath: string,
): Promise<void> {
  const match = payload.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    void vscode.window.showErrorMessage("Invalid image data from editor.");
    return;
  }

  const mime = match[1];
  const buffer = Buffer.from(match[2], "base64");
  const ext = extForMime(mime);
  const fileDir = path.dirname(currentFilePath);
  const subfolder = payload.subfolder.replace(/^\/+|\/+$/g, "") || "images";
  const imagesDir = path.join(fileDir, subfolder);
  fs.mkdirSync(imagesDir, { recursive: true });

  let base = slugify(path.basename(payload.fileName, path.extname(payload.fileName)));
  if (!base) base = "image";
  let destName = `${base}${ext}`;
  let destPath = path.join(imagesDir, destName);
  let n = 1;
  while (fs.existsSync(destPath)) {
    destName = `${base}-${n}${ext}`;
    destPath = path.join(imagesDir, destName);
    n++;
  }

  fs.writeFileSync(destPath, buffer);
  const rel = `./${subfolder}/${destName}`.replace(/\\/g, "/");
  const alt = payload.alt.trim() || base.replace(/-/g, " ");
  await insertBlockBelowCursor(imageMarkup(rel, alt));
  void vscode.window.showInformationMessage(`Image saved as ${rel}`);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function mimeForExt(ext: string): string {
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    default:
      return "image/png";
  }
}

function extForMime(mime: string): string {
  if (mime.includes("jpeg")) return ".jpg";
  if (mime.includes("webp")) return ".webp";
  return ".png";
}

class ImageDialogPanel {
  private static current: ImageDialogPanel | undefined;

  static show(
    dataUrl: string,
    defaultName: string,
    onSave: (payload: ImageSavePayload) => Promise<void>,
  ): void {
    if (ImageDialogPanel.current) {
      ImageDialogPanel.current.panel.reveal();
      ImageDialogPanel.current.loadImage(dataUrl, defaultName);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "fumadocs.imageDialog",
      "Add Image",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    ImageDialogPanel.current = new ImageDialogPanel(panel, onSave);
    ImageDialogPanel.current.loadImage(dataUrl, defaultName);
  }

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly onSave: (payload: ImageSavePayload) => Promise<void>,
  ) {
    panel.webview.html = dialogHtml();
    panel.webview.onDidReceiveMessage(
      async (msg: { type?: string; payload?: ImageSavePayload }) => {
        if (msg.type === "save" && msg.payload) {
          panel.webview.postMessage({ type: "saving" });
          try {
            await onSave(msg.payload);
            panel.dispose();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            panel.webview.postMessage({ type: "error", message });
          }
        }
        if (msg.type === "cancel") panel.dispose();
      },
      undefined,
      this.disposables,
    );
    panel.onDidDispose(() => {
      ImageDialogPanel.current = undefined;
      while (this.disposables.length) this.disposables.pop()?.dispose();
    }, null, this.disposables);
  }

  private loadImage(dataUrl: string, defaultName: string): void {
    void this.panel.webview.postMessage({
      type: "load",
      dataUrl,
      defaultName,
    });
  }
}

function dialogHtml(): string {
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    "img-src data: blob:",
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
    height: 100%;
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  body {
    display: flex;
    flex-direction: column;
    padding: 16px;
    gap: 12px;
  }
  h1 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }
  .hint {
    margin: 0;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }
  .canvas-wrap {
    position: relative;
    flex: 1;
    min-height: 240px;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    border-radius: 6px;
    overflow: hidden;
    background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.15));
    display: flex;
    align-items: center;
    justify-content: center;
  }
  canvas {
    max-width: 100%;
    max-height: 100%;
    cursor: crosshair;
    display: block;
  }
  .controls {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px 16px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
  input[type="text"], select {
    font: inherit;
    font-size: 12px;
    padding: 6px 8px;
    border-radius: 4px;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.45));
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
  }
  input[type="range"] { width: 100%; }
  .range-val { font-size: 11px; color: var(--vscode-foreground); }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 4px;
  }
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
    padding: 8px 14px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .error {
    color: var(--vscode-errorForeground);
    font-size: 12px;
    margin: 0;
  }
</style>
</head>
<body>
  <h1>Crop &amp; optimize</h1>
  <p class="hint">Drag on the image to select a crop region. Adjust size and quality before saving next to your MDX file.</p>
  <div class="canvas-wrap">
    <canvas id="canvas"></canvas>
  </div>
  <div class="controls">
    <label>File name
      <input type="text" id="fileName" value="image" />
    </label>
    <label>Alt text
      <input type="text" id="altText" value="" placeholder="Describe the image" />
    </label>
    <label>Subfolder (relative)
      <input type="text" id="subfolder" value="images" />
    </label>
    <label>Format
      <select id="format">
        <option value="image/webp" selected>WebP (recommended)</option>
        <option value="image/png">PNG</option>
        <option value="image/jpeg">JPEG</option>
      </select>
    </label>
    <label>Max width (px)
      <input type="range" id="maxWidth" min="320" max="2400" step="40" value="1200" />
      <span class="range-val" id="maxWidthVal">1200</span>
    </label>
    <label>Quality
      <input type="range" id="quality" min="50" max="100" step="1" value="85" />
      <span class="range-val" id="qualityVal">85%</span>
    </label>
  </div>
  <p class="error" id="error" hidden></p>
  <div class="actions">
    <button type="button" class="secondary" id="cancelBtn">Cancel</button>
    <button type="button" id="resetCropBtn" class="secondary">Reset crop</button>
    <button type="button" id="saveBtn">Save &amp; insert</button>
  </div>
<script>
(function () {
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const fileName = document.getElementById('fileName');
  const altText = document.getElementById('altText');
  const subfolder = document.getElementById('subfolder');
  const format = document.getElementById('format');
  const maxWidth = document.getElementById('maxWidth');
  const maxWidthVal = document.getElementById('maxWidthVal');
  const quality = document.getElementById('quality');
  const qualityVal = document.getElementById('qualityVal');
  const saveBtn = document.getElementById('saveBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const resetCropBtn = document.getElementById('resetCropBtn');
  const errorEl = document.getElementById('error');

  let sourceImg = null;
  let crop = null;
  let dragging = false;
  let dragStart = null;
  let displayScale = 1;

  function setError(msg) {
    errorEl.hidden = !msg;
    errorEl.textContent = msg || '';
  }

  function fullCrop() {
    if (!sourceImg) return null;
    return { x: 0, y: 0, w: sourceImg.width, h: sourceImg.height };
  }

  function canvasToSource(x, y) {
    return { x: x / displayScale, y: y / displayScale };
  }

  function drawFullWithSelection() {
    if (!sourceImg) return;
    canvas.width = Math.round(sourceImg.width * displayScale);
    canvas.height = Math.round(sourceImg.height * displayScale);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sourceImg, 0, 0, canvas.width, canvas.height);
    if (crop && crop.w > 0 && crop.h > 0) {
      ctx.save();
      ctx.strokeStyle = 'var(--vscode-focusBorder, #007fd4)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(
        crop.x * displayScale,
        crop.y * displayScale,
        crop.w * displayScale,
        crop.h * displayScale
      );
      ctx.restore();
    }
  }

  function drawPreview() {
    if (!sourceImg || !crop) return;
    const maxW = parseInt(maxWidth.value, 10);
    const scale = Math.min(1, maxW / crop.w);
    const outW = Math.max(1, Math.round(crop.w * scale));
    const outH = Math.max(1, Math.round(crop.h * scale));
    const maxDisplay = 560;
    const previewScale = Math.min(1, maxDisplay / outW, maxDisplay / outH);
    canvas.width = Math.round(outW * previewScale);
    canvas.height = Math.round(outH * previewScale);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(
      sourceImg,
      crop.x, crop.y, crop.w, crop.h,
      0, 0, canvas.width, canvas.height
    );
  }

  function canvasCoords(evt) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return canvasToSource(
      (evt.clientX - rect.left) * scaleX,
      (evt.clientY - rect.top) * scaleY
    );
  }

  canvas.addEventListener('mousedown', (evt) => {
    if (!sourceImg) return;
    dragging = true;
    dragStart = canvasCoords(evt);
    crop = { x: dragStart.x, y: dragStart.y, w: 0, h: 0 };
    drawFullWithSelection();
  });

  canvas.addEventListener('mousemove', (evt) => {
    if (!dragging || !sourceImg || !dragStart) return;
    const pos = canvasCoords(evt);
    const x = Math.min(dragStart.x, pos.x);
    const y = Math.min(dragStart.y, pos.y);
    const w = Math.abs(pos.x - dragStart.x);
    const h = Math.abs(pos.y - dragStart.y);
    crop = {
      x: Math.max(0, Math.round(x)),
      y: Math.max(0, Math.round(y)),
      w: Math.min(sourceImg.width, Math.round(w)),
      h: Math.min(sourceImg.height, Math.round(h)),
    };
    drawFullWithSelection();
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    if (crop && (crop.w < 4 || crop.h < 4)) crop = fullCrop();
    drawPreview();
  });

  function exportImage(cb) {
    if (!sourceImg || !crop) return cb(null);
    const maxW = parseInt(maxWidth.value, 10);
    const scale = Math.min(1, maxW / crop.w);
    const outW = Math.max(1, Math.round(crop.w * scale));
    const outH = Math.max(1, Math.round(crop.h * scale));
    const off = document.createElement('canvas');
    off.width = outW;
    off.height = outH;
    const offCtx = off.getContext('2d');
    offCtx.drawImage(
      sourceImg,
      crop.x, crop.y, crop.w, crop.h,
      0, 0, outW, outH
    );
    const mime = format.value;
    const q = parseInt(quality.value, 10) / 100;
    const dataUrl = mime === 'image/png'
      ? off.toDataURL('image/png')
      : off.toDataURL(mime, q);
    cb(dataUrl);
  }

  maxWidth.addEventListener('input', () => {
    maxWidthVal.textContent = maxWidth.value;
    drawPreview();
  });
  quality.addEventListener('input', () => {
    qualityVal.textContent = quality.value + '%';
  });

  resetCropBtn.addEventListener('click', () => {
    crop = fullCrop();
    drawFullWithSelection();
  });

  cancelBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
  });

  saveBtn.addEventListener('click', () => {
    setError('');
    exportImage((dataUrl) => {
      if (!dataUrl) {
        setError('Could not process image.');
        return;
      }
      saveBtn.disabled = true;
      vscode.postMessage({
        type: 'save',
        payload: {
          dataUrl,
          fileName: fileName.value.trim() || 'image',
          alt: altText.value.trim(),
          subfolder: subfolder.value.trim() || 'images',
        },
      });
    });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'load') {
      setError('');
      saveBtn.disabled = false;
      fileName.value = msg.defaultName || 'image';
      altText.value = (msg.defaultName || 'image').replace(/-/g, ' ');
      const img = new Image();
      img.onload = () => {
        sourceImg = img;
        crop = fullCrop();
        const maxDisplay = 560;
        displayScale = Math.min(1, maxDisplay / img.width, maxDisplay / img.height);
        drawFullWithSelection();
      };
      img.onerror = () => setError('Failed to load image.');
      img.src = msg.dataUrl;
    }
    if (msg.type === 'saving') saveBtn.textContent = 'Saving…';
    if (msg.type === 'error') {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save & insert';
      setError(msg.message || 'Save failed.');
    }
  });
})();
</script>
</body>
</html>`;
}
