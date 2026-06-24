import * as vscode from "vscode";
import * as path from "node:path";

const IMAGE_FOLDER = "images";

const sanitize = (name: string): string =>
  name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "");

/** Pick a destination name that does not clash with an existing file. */
const uniqueName = async (
  folder: vscode.Uri,
  fileName: string,
): Promise<string> => {
  const ext = path.extname(fileName);
  const base = sanitize(path.basename(fileName, ext)) || "image";
  let candidate = `${base}${ext}`;
  let counter = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, candidate));
      candidate = `${base}-${counter}${ext}`;
      counter++;
    } catch {
      return candidate;
    }
  }
};

const toRelative = (fromFile: string, toFile: string): string => {
  let relative = path.relative(path.dirname(fromFile), toFile);
  relative = relative.split(path.sep).join("/");
  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }
  return relative;
};

export const insertImage = async (): Promise<void> => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("Open an MDX file first.");
    return;
  }

  const docUri = editor.document.uri;
  if (docUri.scheme !== "file") {
    void vscode.window.showWarningMessage(
      "Save the document to disk before inserting an image.",
    );
    return;
  }

  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Insert image",
    filters: {
      Images: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"],
    },
  });
  if (!picked || picked.length === 0) {
    return;
  }
  const source = picked[0];

  const docDir = path.dirname(docUri.fsPath);
  const imagesDir = vscode.Uri.file(path.join(docDir, IMAGE_FOLDER));
  await vscode.workspace.fs.createDirectory(imagesDir);

  const destName = await uniqueName(imagesDir, path.basename(source.fsPath));
  const dest = vscode.Uri.joinPath(imagesDir, destName);

  try {
    const data = await vscode.workspace.fs.readFile(source);
    await vscode.workspace.fs.writeFile(dest, data);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not copy the image: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  const relativePath = toRelative(docUri.fsPath, dest.fsPath);

  const syntaxChoice = await vscode.window.showQuickPick(
    [
      {
        label: "Markdown image",
        detail: "![alt](path) — simplest, always renders.",
        value: "markdown" as const,
      },
      {
        label: "Zoomable image (<ImageZoom>)",
        detail: "Click-to-zoom. Requires ImageZoom registered in your app.",
        value: "imagezoom" as const,
      },
    ],
    {
      title: "How should the image be inserted?",
      placeHolder: "Choose the image syntax",
    },
  );
  if (!syntaxChoice) {
    return;
  }

  const altDefault = path
    .basename(destName, path.extname(destName))
    .replace(/[-_]+/g, " ");

  const snippet =
    syntaxChoice.value === "imagezoom"
      ? new vscode.SnippetString(
          `<ImageZoom src="${relativePath}" alt="\${1:${altDefault}}" />\n`,
        )
      : new vscode.SnippetString(`![\${1:${altDefault}}](${relativePath})\n`);

  await editor.insertSnippet(snippet);
};
