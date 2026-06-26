import * as path from "path";
import * as vscode from "vscode";
import {
  discoverFolderItems,
  emptyMeta,
  type FolderEntry,
  type MetaDoc,
  type PagesItem,
} from "./meta/metaModel";
import { readMetaDoc, resolveMetaUri, writeMetaDoc } from "./meta/metaWrite";

type TriBool = "unset" | "true" | "false";

/** Editable projection of a meta doc, exchanged with the webview. */
interface EditableMeta {
  title: string;
  description: string;
  icon: string;
  pagesIndex: string;
  root: TriBool;
  defaultOpen: TriBool;
  collapsible: TriBool;
  includePages: boolean;
  pages: PagesItem[];
}

interface LightEntry {
  slug: string;
  type: "page" | "folder";
}

function fromBool(v: boolean | undefined): TriBool {
  if (v === true) return "true";
  if (v === false) return "false";
  return "unset";
}

function toBool(v: TriBool): boolean | undefined {
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

function toEditable(doc: MetaDoc): EditableMeta {
  return {
    title: doc.title ?? "",
    description: doc.description ?? "",
    icon: doc.icon ?? "",
    pagesIndex: doc.pagesIndex ?? "",
    root: fromBool(doc.root),
    defaultOpen: fromBool(doc.defaultOpen),
    collapsible: fromBool(doc.collapsible),
    includePages: doc.pages !== undefined,
    pages: doc.pages ?? [],
  };
}

function mergeEditable(base: MetaDoc, e: EditableMeta): MetaDoc {
  const trim = (s: string): string | undefined => {
    const v = s.trim();
    return v.length > 0 ? v : undefined;
  };
  return {
    schema: base.schema,
    title: trim(e.title),
    description: trim(e.description),
    icon: trim(e.icon),
    pagesIndex: trim(e.pagesIndex),
    root: toBool(e.root),
    defaultOpen: toBool(e.defaultOpen),
    collapsible: toBool(e.collapsible),
    pages: e.includePages ? e.pages : undefined,
    extra: base.extra,
  };
}

/**
 * A single reusable webview panel that visually edits a folder's `meta.json`.
 * Edits are written to the meta file's (unsaved) buffer live so the Fumadocs
 * preview reflects them immediately; "Save" persists to disk.
 */
export class MetaEditorPanel {
  private static current: MetaEditorPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private folderDir = "";
  private metaUri: vscode.Uri | undefined;
  private baseDoc: MetaDoc = emptyMeta();
  private applyDebounce: ReturnType<typeof setTimeout> | undefined;

  static open(folderDir: string): void {
    if (MetaEditorPanel.current) {
      MetaEditorPanel.current.panel.reveal(vscode.ViewColumn.Active, false);
      MetaEditorPanel.current.load(folderDir);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "fumadocs.metaEditor",
      "Edit meta.json",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );
    MetaEditorPanel.current = new MetaEditorPanel(panel);
    MetaEditorPanel.current.load(folderDir);
  }

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.webview.html = editorHtml();
    this.panel.webview.onDidReceiveMessage(
      (msg: { type?: string; editable?: EditableMeta }) => {
        if (msg.type === "ready") this.postInit();
        else if (msg.type === "apply" && msg.editable) {
          this.scheduleApply(msg.editable);
        } else if (msg.type === "save") void this.save();
        else if (msg.type === "openFile") void this.openFile();
      },
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private load(folderDir: string): void {
    this.folderDir = folderDir;
    this.metaUri = resolveMetaUri(folderDir);
    this.baseDoc = readMetaDoc(folderDir) ?? emptyMeta();
    this.panel.title = `meta.json — ${path.basename(folderDir)}`;
    this.postInit();
  }

  private postInit(): void {
    if (!this.folderDir) return;
    const entries: LightEntry[] = discoverFolderItems(this.folderDir).map(
      (e: FolderEntry) => ({ slug: e.slug, type: e.type }),
    );
    void this.panel.webview.postMessage({
      type: "init",
      editable: toEditable(this.baseDoc),
      entries,
      folderName: path.basename(this.folderDir),
      fileName: this.metaUri ? path.basename(this.metaUri.fsPath) : "meta.json",
    });
  }

  private scheduleApply(editable: EditableMeta): void {
    if (this.applyDebounce) clearTimeout(this.applyDebounce);
    this.applyDebounce = setTimeout(() => void this.apply(editable), 200);
  }

  private async apply(editable: EditableMeta): Promise<void> {
    if (!this.metaUri) return;
    const next = mergeEditable(this.baseDoc, editable);
    await writeMetaDoc(this.metaUri, next);
  }

  private async save(): Promise<void> {
    if (!this.metaUri) return;
    if (this.applyDebounce) clearTimeout(this.applyDebounce);
    try {
      const doc = await vscode.workspace.openTextDocument(this.metaUri);
      await doc.save();
      void vscode.window.showInformationMessage(
        `Saved ${path.basename(this.metaUri.fsPath)}.`,
      );
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Could not save meta file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async openFile(): Promise<void> {
    if (!this.metaUri) return;
    const doc = await vscode.workspace.openTextDocument(this.metaUri);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
  }

  private dispose(): void {
    MetaEditorPanel.current = undefined;
    if (this.applyDebounce) clearTimeout(this.applyDebounce);
    while (this.disposables.length) this.disposables.pop()?.dispose();
    this.panel.dispose();
  }
}

function editorHtml(): string {
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
  html, body { margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .wrap { max-width: 760px; margin: 0 auto; padding: 16px 18px 96px; }
  h1 { font-size: 15px; margin: 0 0 2px; }
  .sub { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 0 0 18px; }
  .section-title { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin: 18px 0 8px; }
  label.field { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  input[type="text"], textarea, select { font: inherit; font-size: 12px; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.45)); background: var(--vscode-input-background); color: var(--vscode-input-foreground); width: 100%; }
  textarea { resize: vertical; min-height: 44px; }
  button { appearance: none; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; font: inherit; font-size: 12px; font-weight: 600; padding: 6px 12px; }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button.tiny { padding: 2px 7px; font-size: 11px; font-weight: 600; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .toggle { display: flex; align-items: center; gap: 8px; font-size: 12px; margin-bottom: 10px; }
  .toggle input { width: auto; }
  .pages-box { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3)); border-radius: 8px; padding: 10px; }
  .item { border: 1px dashed var(--vscode-panel-border, rgba(128,128,128,0.4)); border-radius: 6px; padding: 8px; margin-bottom: 8px; }
  .item-head { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
  .item-head select { flex: 1; }
  .item-fields { display: flex; flex-direction: column; gap: 6px; }
  .item-fields .row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .muted { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
  .footer { position: fixed; left: 0; right: 0; bottom: 0; display: flex; gap: 8px; justify-content: flex-end; padding: 10px 18px; background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background)); border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); }
  .empty { font-size: 12px; color: var(--vscode-descriptionForeground); padding: 6px 2px; }
  .chiprow { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
</style>
</head>
<body>
  <div class="wrap">
    <h1 id="title">Edit meta.json</h1>
    <p class="sub" id="sub"></p>

    <div class="section-title">Folder</div>
    <label class="field">Title<input type="text" id="f-title" placeholder="Display name" /></label>
    <label class="field">Description<textarea id="f-description" placeholder="Optional description"></textarea></label>
    <div class="row2">
      <label class="field">Icon (lucide name)<input type="text" id="f-icon" placeholder="e.g. Book" /></label>
      <label class="field">Index item (pagesIndex)<input type="text" id="f-pagesIndex" placeholder="e.g. overview" /></label>
    </div>
    <div class="row2">
      <label class="field">Root folder<select id="f-root"></select></label>
      <label class="field">Open by default<select id="f-defaultOpen"></select></label>
    </div>
    <label class="field">Collapsible<select id="f-collapsible"></select></label>

    <div class="section-title">Pages</div>
    <div class="toggle">
      <input type="checkbox" id="f-includePages" />
      <label for="f-includePages">Control item order and visibility with a <code>pages</code> list</label>
    </div>
    <div id="pagesArea"></div>
  </div>

  <div class="footer">
    <button type="button" class="secondary" id="btn-open">Open file</button>
    <button type="button" id="btn-save">Save</button>
  </div>

<script>
(function () {
  var vscode = acquireVsCodeApi();
  var state = null;     // EditableMeta
  var entries = [];     // [{slug,type}]

  var KINDS = [
    { id: 'path', label: 'Page / Folder' },
    { id: 'separator', label: 'Separator' },
    { id: 'link', label: 'Link' },
    { id: 'rest', label: 'Rest (...)' },
    { id: 'reversed-rest', label: 'Reversed rest (z...a)' },
    { id: 'extract', label: 'Extract folder (...folder)' },
    { id: 'except', label: 'Exclude (!item)' }
  ];

  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  var applyTimer = null;
  function scheduleApply() {
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = setTimeout(function () {
      vscode.postMessage({ type: 'apply', editable: state });
    }, 220);
  }

  function defaultItem(kind) {
    if (kind === 'path') return { kind: 'path', value: '' };
    if (kind === 'separator') return { kind: 'separator', label: 'Section', icon: '' };
    if (kind === 'link') return { kind: 'link', text: 'Label', url: 'https://', icon: '', external: false };
    if (kind === 'extract') return { kind: 'extract', value: '' };
    if (kind === 'except') return { kind: 'except', value: '' };
    return { kind: kind };
  }

  function fillBoolSelect(el) {
    el.innerHTML = '';
    [['unset','(default)'],['true','Yes'],['false','No']].forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o[0]; opt.textContent = o[1];
      el.appendChild(opt);
    });
  }

  function bindScalar(id, key) {
    var el = document.getElementById(id);
    el.addEventListener('input', function () { state[key] = el.value; scheduleApply(); });
    el.addEventListener('change', function () { state[key] = el.value; scheduleApply(); });
    return el;
  }

  function referenced() {
    var set = {};
    (state.pages || []).forEach(function (it) {
      if (it.kind === 'path' || it.kind === 'extract') {
        set[String(it.value || '').replace(/^\\.\\//,'').replace(/\\/+$/,'')] = true;
      }
    });
    return set;
  }

  function missingEntries() {
    var ref = referenced();
    var hasRest = (state.pages || []).some(function (it) { return it.kind === 'rest' || it.kind === 'reversed-rest'; });
    if (hasRest) return [];
    return entries.filter(function (e) { return !ref[e.slug]; });
  }

  function renderItemFields(item, index) {
    var box = document.createElement('div');
    box.className = 'item-fields';

    function textField(labelText, value, onInput, placeholder) {
      var wrap = document.createElement('label');
      wrap.className = 'field';
      wrap.textContent = labelText;
      var inp = document.createElement('input');
      inp.type = 'text'; inp.value = value || '';
      if (placeholder) inp.placeholder = placeholder;
      inp.addEventListener('input', function () { onInput(inp.value); scheduleApply(); });
      wrap.appendChild(inp);
      return wrap;
    }

    if (item.kind === 'path') {
      box.appendChild(textField('Path / slug', item.value, function (v) { item.value = v; }, 'e.g. getting-started or folder'));
    } else if (item.kind === 'extract') {
      box.appendChild(textField('Folder to extract', item.value, function (v) { item.value = v; }, 'subfolder name'));
    } else if (item.kind === 'except') {
      box.appendChild(textField('Item to exclude', item.value, function (v) { item.value = v; }, 'slug to drop from rest'));
    } else if (item.kind === 'separator') {
      var row = document.createElement('div'); row.className = 'row';
      row.appendChild(textField('Label', item.label, function (v) { item.label = v; }, 'Section'));
      row.appendChild(textField('Icon (optional)', item.icon, function (v) { item.icon = v; }, 'lucide name'));
      box.appendChild(row);
    } else if (item.kind === 'link') {
      var r1 = document.createElement('div'); r1.className = 'row';
      r1.appendChild(textField('Text', item.text, function (v) { item.text = v; }, 'Label'));
      r1.appendChild(textField('URL', item.url, function (v) { item.url = v; }, 'https://'));
      box.appendChild(r1);
      var r2 = document.createElement('div'); r2.className = 'row';
      r2.appendChild(textField('Icon (optional)', item.icon, function (v) { item.icon = v; }, 'lucide name'));
      var extWrap = document.createElement('label'); extWrap.className = 'toggle';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!item.external;
      cb.addEventListener('change', function () { item.external = cb.checked; scheduleApply(); });
      extWrap.appendChild(cb);
      var span = document.createElement('span'); span.textContent = 'External link';
      extWrap.appendChild(span);
      r2.appendChild(extWrap);
      box.appendChild(r2);
    } else {
      var note = document.createElement('div'); note.className = 'muted';
      note.textContent = item.kind === 'rest'
        ? 'Includes all remaining pages (sorted alphabetically).'
        : 'Includes remaining pages in reverse order.';
      box.appendChild(note);
    }
    return box;
  }

  function renderItem(item, index) {
    var el = document.createElement('div');
    el.className = 'item';

    var head = document.createElement('div');
    head.className = 'item-head';

    var sel = document.createElement('select');
    KINDS.forEach(function (k) {
      var o = document.createElement('option');
      o.value = k.id; o.textContent = k.label;
      if (k.id === item.kind) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      state.pages[index] = defaultItem(sel.value);
      renderPages();
      scheduleApply();
    });
    head.appendChild(sel);

    var up = document.createElement('button');
    up.type = 'button'; up.className = 'secondary tiny'; up.textContent = '↑';
    up.disabled = index === 0;
    up.addEventListener('click', function () { swap(index, index - 1); });
    head.appendChild(up);

    var down = document.createElement('button');
    down.type = 'button'; down.className = 'secondary tiny'; down.textContent = '↓';
    down.disabled = index === state.pages.length - 1;
    down.addEventListener('click', function () { swap(index, index + 1); });
    head.appendChild(down);

    var rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'secondary tiny'; rm.textContent = 'Remove';
    rm.addEventListener('click', function () { state.pages.splice(index, 1); renderPages(); scheduleApply(); });
    head.appendChild(rm);

    el.appendChild(head);
    el.appendChild(renderItemFields(item, index));
    return el;
  }

  function swap(a, b) {
    if (b < 0 || b >= state.pages.length) return;
    var t = state.pages[a]; state.pages[a] = state.pages[b]; state.pages[b] = t;
    renderPages();
    scheduleApply();
  }

  function renderPages() {
    var area = document.getElementById('pagesArea');
    area.innerHTML = '';
    if (!state.includePages) {
      var note = document.createElement('div');
      note.className = 'empty';
      note.textContent = 'Without a pages list, items are shown alphabetically. Enable the option above to control order, add separators or links, or hide items.';
      area.appendChild(note);
      return;
    }

    var box = document.createElement('div');
    box.className = 'pages-box';

    if (!state.pages.length) {
      var em = document.createElement('div');
      em.className = 'empty';
      em.textContent = 'No items yet. Add pages below.';
      box.appendChild(em);
    }
    state.pages.forEach(function (item, i) { box.appendChild(renderItem(item, i)); });

    var actions = document.createElement('div');
    actions.className = 'actions';

    var add = document.createElement('button');
    add.type = 'button'; add.className = 'secondary'; add.textContent = '+ Add item';
    add.addEventListener('click', function () { state.pages.push(defaultItem('path')); renderPages(); scheduleApply(); });
    actions.appendChild(add);

    var addRest = document.createElement('button');
    addRest.type = 'button'; addRest.className = 'secondary'; addRest.textContent = '+ Rest (...)';
    addRest.addEventListener('click', function () { state.pages.push({ kind: 'rest' }); renderPages(); scheduleApply(); });
    actions.appendChild(addRest);

    box.appendChild(actions);

    // Insert-existing palette + add-all-missing.
    var miss = missingEntries();
    var chip = document.createElement('div');
    chip.className = 'chiprow';
    if (miss.length) {
      var picker = document.createElement('select');
      var ph = document.createElement('option'); ph.value=''; ph.textContent='Insert existing page…';
      picker.appendChild(ph);
      miss.forEach(function (e) {
        var o = document.createElement('option');
        o.value = e.slug; o.textContent = e.slug + (e.type === 'folder' ? '/' : '');
        picker.appendChild(o);
      });
      picker.addEventListener('change', function () {
        if (!picker.value) return;
        state.pages.push({ kind: 'path', value: picker.value });
        renderPages(); scheduleApply();
      });
      chip.appendChild(picker);

      var all = document.createElement('button');
      all.type = 'button'; all.className = 'secondary tiny';
      all.textContent = 'Add all ' + miss.length + ' missing';
      all.addEventListener('click', function () {
        miss.forEach(function (e) { state.pages.push({ kind: 'path', value: e.slug }); });
        renderPages(); scheduleApply();
      });
      chip.appendChild(all);
    } else {
      var ok = document.createElement('span');
      ok.className = 'muted';
      ok.textContent = 'All pages in this folder are included.';
      chip.appendChild(ok);
    }
    box.appendChild(chip);

    area.appendChild(box);
  }

  function applyInit(msg) {
    state = msg.editable;
    entries = msg.entries || [];
    document.getElementById('title').textContent = 'Edit ' + msg.fileName;
    document.getElementById('sub').textContent = 'Folder: ' + msg.folderName;

    document.getElementById('f-title').value = state.title || '';
    document.getElementById('f-description').value = state.description || '';
    document.getElementById('f-icon').value = state.icon || '';
    document.getElementById('f-pagesIndex').value = state.pagesIndex || '';
    document.getElementById('f-root').value = state.root || 'unset';
    document.getElementById('f-defaultOpen').value = state.defaultOpen || 'unset';
    document.getElementById('f-collapsible').value = state.collapsible || 'unset';
    document.getElementById('f-includePages').checked = !!state.includePages;
    renderPages();
  }

  // Wire scalar inputs.
  fillBoolSelect(document.getElementById('f-root'));
  fillBoolSelect(document.getElementById('f-defaultOpen'));
  fillBoolSelect(document.getElementById('f-collapsible'));
  bindScalar('f-title', 'title');
  bindScalar('f-description', 'description');
  bindScalar('f-icon', 'icon');
  bindScalar('f-pagesIndex', 'pagesIndex');
  bindScalar('f-root', 'root');
  bindScalar('f-defaultOpen', 'defaultOpen');
  bindScalar('f-collapsible', 'collapsible');

  document.getElementById('f-includePages').addEventListener('change', function () {
    state.includePages = this.checked;
    if (state.includePages && (!state.pages || !state.pages.length)) {
      state.pages = entries.map(function (e) { return { kind: 'path', value: e.slug }; });
    }
    renderPages();
    scheduleApply();
  });

  document.getElementById('btn-save').addEventListener('click', function () { vscode.postMessage({ type: 'save' }); });
  document.getElementById('btn-open').addEventListener('click', function () { vscode.postMessage({ type: 'openFile' }); });

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (msg && msg.type === 'init') applyInit(msg);
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
