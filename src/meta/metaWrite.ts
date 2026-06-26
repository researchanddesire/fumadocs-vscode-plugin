import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { parseMeta, serializeMeta, type MetaDoc } from "./metaModel";

/** Resolve the meta file uri for a folder, preferring an existing meta.jsonc. */
export function resolveMetaUri(folderDir: string): vscode.Uri {
  const jsonc = path.join(folderDir, "meta.jsonc");
  if (fs.existsSync(jsonc)) return vscode.Uri.file(jsonc);
  return vscode.Uri.file(path.join(folderDir, "meta.json"));
}

/** Read and parse the meta file for a folder, or null if none/invalid. */
export function readMetaDoc(folderDir: string): MetaDoc | null {
  const uri = resolveMetaUri(folderDir);
  try {
    const raw = fs.readFileSync(uri.fsPath, "utf8");
    return parseMeta(raw);
  } catch {
    return null;
  }
}

/**
 * Write a {@link MetaDoc} to `uri`, creating the file if it doesn't exist and
 * replacing its full contents otherwise. The edit goes through a
 * WorkspaceEdit so the change lands in an (unsaved) editor buffer, which the
 * preview's override pipeline mirrors live. Returns whether the edit applied.
 */
export async function writeMetaDoc(
  uri: vscode.Uri,
  doc: MetaDoc,
): Promise<boolean> {
  const content = serializeMeta(doc);

  if (!fs.existsSync(uri.fsPath)) {
    const create = new vscode.WorkspaceEdit();
    create.createFile(uri, { ignoreIfExists: true });
    const created = await vscode.workspace.applyEdit(create);
    if (!created) return false;
  }

  const document = await vscode.workspace.openTextDocument(uri);
  if (document.getText() === content) return true;

  const fullRange = new vscode.Range(
    new vscode.Position(0, 0),
    document.lineAt(Math.max(0, document.lineCount - 1)).range.end,
  );
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, fullRange, content);
  return vscode.workspace.applyEdit(edit);
}
