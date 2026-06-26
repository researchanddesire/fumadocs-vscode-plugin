import * as vscode from "vscode";
import { isMarkdown } from "./markdown";

/** A detected image reference in an MD/MDX document. */
interface ImageHit {
  /** Source path or URL. */
  src: string;
  /** Alt text (may be empty). */
  alt: string;
  /** "img" = JSX `<img>` tag; "md" = Markdown `![]()`. */
  kind: "img" | "md";
  /** Range covering the full reference (replaced when saving edits). */
  range: vscode.Range;
}

const FENCE = /^\s*(```|~~~)/;
// `<img ... />` or `<img ...>` on a single line.
const IMG_TAG = /<img\b[^>]*?\/?>/gi;
// Markdown image: ![alt](src "title"?)
const MD_IMG = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

function attr(src: string, name: string): string | null {
  const m = new RegExp(String.raw`${name}\s*=\s*"([^"]*)"`, "i").exec(src);
  return m ? m[1] : null;
}

/** Scan a document for image references outside fenced code blocks. */
function findImages(document: vscode.TextDocument): ImageHit[] {
  const hits: ImageHit[] = [];
  let inCode = false;

  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    if (FENCE.test(text)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;

    IMG_TAG.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMG_TAG.exec(text))) {
      const tag = m[0];
      hits.push({
        src: attr(tag, "src") || "",
        alt: attr(tag, "alt") || "",
        kind: "img",
        range: new vscode.Range(line, m.index, line, m.index + tag.length),
      });
    }

    MD_IMG.lastIndex = 0;
    while ((m = MD_IMG.exec(text))) {
      hits.push({
        alt: m[1] || "",
        src: m[2] || "",
        kind: "md",
        range: new vscode.Range(line, m.index, line, m.index + m[0].length),
      });
    }
  }

  return hits;
}

/**
 * Adds an "Edit image" CodeLens above every `<img>` tag and Markdown image in
 * an MD/MDX file, opening the Docs Tools image builder pre-filled with the
 * current source and alt text.
 */
export class ImageEditCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeCodeLensesEmitter =
    new vscode.EventEmitter<void>();

  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  refresh(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isMarkdown(document)) return [];

    return findImages(document).map((hit) => {
      const anchor = new vscode.Range(
        hit.range.start.line,
        hit.range.start.character,
        hit.range.start.line,
        hit.range.start.character,
      );
      return new vscode.CodeLens(anchor, {
        title: "$(device-camera) Edit image",
        tooltip: "Open this image in the Fumadocs image builder",
        command: "fumadocs.editImage",
        arguments: [document.uri, hit.range, hit.src, hit.alt, hit.kind],
      });
    });
  }
}
