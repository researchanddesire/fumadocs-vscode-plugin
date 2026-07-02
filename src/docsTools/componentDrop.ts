import * as vscode from "vscode";
import { isMarkdown } from "../markdown";
import { FUMADOCS_COMPONENT_MIME } from "./componentSnippets";
import { createBlockInsertionPlan } from "./insertPlan";
import { documentLines, toRange } from "./insertAtCursor";

interface DraggedComponent {
  label?: string;
  snippet?: string;
}

export class ComponentDropProvider implements vscode.DocumentDropEditProvider {
  async provideDocumentDropEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    dataTransfer: vscode.DataTransfer,
  ): Promise<vscode.DocumentDropEdit | undefined> {
    if (!isMarkdown(document)) return undefined;

    const item = dataTransfer.get(FUMADOCS_COMPONENT_MIME);
    if (!item) return undefined;

    const payload = parseDraggedComponent(await item.asString());
    if (!payload?.snippet?.trim()) return undefined;

    const activeSelection = activeSelectionFor(document.uri, position);
    const anchorLine = activeSelection?.end.line ?? position.line;
    const plan = createBlockInsertionPlan(documentLines(document), anchorLine, payload.snippet);
    const edit = new vscode.DocumentDropEdit(
      activeSelection ? document.getText(activeSelection) : "",
      `Insert ${payload.label || "Fumadocs component"}`,
      vscode.DocumentDropOrPasteEditKind.Text,
    );
    const additionalEdit = new vscode.WorkspaceEdit();
    additionalEdit.replace(document.uri, toRange(plan.range), plan.text);
    edit.additionalEdit = additionalEdit;
    return edit;
  }
}

function activeSelectionFor(
  uri: vscode.Uri,
  position: vscode.Position,
): vscode.Selection | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== uri.toString()) {
    return undefined;
  }

  const selection = editor.selection;
  if (selection.isEmpty || !selection.contains(position)) return undefined;
  return selection;
}

function parseDraggedComponent(raw: string): DraggedComponent | undefined {
  try {
    const parsed = JSON.parse(raw) as DraggedComponent;
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}
