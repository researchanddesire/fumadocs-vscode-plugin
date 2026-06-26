import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/** A loaded image ready to display in the builder webview. */
export interface LoadedImage {
  dataUrl: string;
  /** Suggested base name (no extension), already slugified. */
  name: string;
}

/** Payload sent from the image builder when the user inserts/saves. */
export interface ImageInsertPayload {
  /** "file" = persist bytes locally; "url" = reference a remote URL as-is. */
  mode: "file" | "url";
  /** Present when mode === "file": optimized image as a base64 data URL. */
  dataUrl?: string;
  /** Present when mode === "url": remote URL to reference directly. */
  url?: string;
  fileName: string;
  subfolder: string;
  alt: string;
  /** Edit mode: existing src, reused (no rewrite) when the image is unchanged. */
  keepSrc?: string;
  /** Whether the image bytes/crop/compression actually changed. */
  dirty?: boolean;
}

/** Open a native file picker and return the chosen image as a data URL. */
export async function pickImageFile(): Promise<LoadedImage | null> {
  const picks = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Select image",
    filters: {
      Images: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"],
    },
  });
  if (!picks?.length) return null;

  const sourcePath = picks[0].fsPath;
  return readImageFile(sourcePath);
}

/** Read a local image file from disk and return it as a data URL. */
function readImageFile(sourcePath: string): LoadedImage | null {
  try {
    const buffer = fs.readFileSync(sourcePath);
    const ext = path.extname(sourcePath).toLowerCase();
    const mime = mimeForExt(ext);
    const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
    const name = slugify(path.basename(sourcePath, ext)) || "image";
    return { dataUrl, name };
  } catch {
    return null;
  }
}

/**
 * Resolve an `<img>`/markdown `src` (relative or absolute) against the MDX
 * file's directory and load it from disk for re-editing. Returns null for
 * remote URLs or missing files.
 */
export function readLocalImageForSrc(
  src: string,
  mdxFilePath: string,
): LoadedImage | null {
  if (isRemote(src) || src.startsWith("data:")) return null;
  const abs = path.isAbsolute(src)
    ? src
    : path.resolve(path.dirname(mdxFilePath), src);
  if (!fs.existsSync(abs)) return null;
  return readImageFile(abs);
}

/** Download a remote image and return it as a data URL (for crop/optimize). */
export async function fetchRemoteImage(url: string): Promise<LoadedImage> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
  const mime = res.headers.get("content-type") || "image/png";
  const buffer = Buffer.from(await res.arrayBuffer());
  const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
  const base = url.split("?")[0].split("#")[0].split("/").pop() || "image";
  const dot = base.lastIndexOf(".");
  const name = slugify(dot > 0 ? base.slice(0, dot) : base) || "image";
  return { dataUrl, name };
}

/**
 * Persist the payload next to `mdxFilePath` and return the relative `src` to
 * reference. For URL mode the URL is returned untouched; for file mode the
 * bytes are written (overwriting `keepSrc` in place when the target path is
 * unchanged, otherwise picking a collision-free name).
 */
export function resolveImageSrc(
  payload: ImageInsertPayload,
  mdxFilePath: string,
): string {
  if (payload.mode === "url") {
    return (payload.url || "").trim();
  }

  // Unchanged existing image — keep referencing it without rewriting.
  if (payload.dirty === false && payload.keepSrc) return payload.keepSrc;

  const match = /^data:([^;]+);base64,(.+)$/.exec(payload.dataUrl || "");
  if (!match) throw new Error("Invalid image data.");
  const mime = match[1];
  const buffer = Buffer.from(match[2], "base64");
  const ext = extForMime(mime);

  const fileDir = path.dirname(mdxFilePath);
  const subfolder = payload.subfolder.replace(/^[./]+|\/+$/g, "") || "images";
  const imagesDir = path.join(fileDir, subfolder);
  fs.mkdirSync(imagesDir, { recursive: true });

  const base = slugify(path.basename(payload.fileName, path.extname(payload.fileName))) || "image";
  const candidateRel = `./${subfolder}/${base}${ext}`;

  // Overwrite in place when editing and the target path matches the original.
  if (payload.keepSrc && normalizeRel(payload.keepSrc) === normalizeRel(candidateRel)) {
    fs.writeFileSync(path.join(imagesDir, `${base}${ext}`), buffer);
    return candidateRel;
  }

  let destName = `${base}${ext}`;
  let destPath = path.join(imagesDir, destName);
  let n = 1;
  while (fs.existsSync(destPath)) {
    destName = `${base}-${n}${ext}`;
    destPath = path.join(imagesDir, destName);
    n++;
  }
  fs.writeFileSync(destPath, buffer);
  return `./${subfolder}/${destName}`.replaceAll("\\", "/");
}

/** Build image markup, preferring `<img>` for MDX and `![]()` for Markdown. */
export function buildImageMarkup(
  src: string,
  alt: string,
  useImgTag: boolean,
): string {
  const safeAlt = alt.replace(/"/g, '\\"');
  if (useImgTag) return `<img src="${src}" alt="${safeAlt}" />`;
  return `![${alt}](${src})`;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

function isRemote(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

function normalizeRel(rel: string): string {
  return rel.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
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
    case ".avif":
      return "image/avif";
    case ".svg":
      return "image/svg+xml";
    default:
      return "image/png";
  }
}

function extForMime(mime: string): string {
  if (mime.includes("jpeg")) return ".jpg";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("gif")) return ".gif";
  if (mime.includes("avif")) return ".avif";
  if (mime.includes("svg")) return ".svg";
  if (mime.includes("bmp")) return ".bmp";
  return ".png";
}
