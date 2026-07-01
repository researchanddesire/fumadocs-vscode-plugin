import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * On-disk cache of the pristine (pre-crop, pre-compression) source for every
 * image written by the builder, keyed by the saved file's absolute path.
 *
 * This lets a later "Edit image" reload the full-resolution original so the
 * user can revert the crop or change quality without compounding the lossy
 * re-encode of the already-saved file. It lives in the OS temp directory and is
 * purely a convenience — every read/write is best-effort and never blocks a
 * save or edit if it fails.
 */
const CACHE_DIR = path.join(os.tmpdir(), "fumadocs-vscode-image-cache");

/** Crop rectangle in the original image's natural pixel coordinates. */
interface ImageCrop {
  x: number;
  y: number;
  width: number;
  height: number;
  rotate?: number;
  scaleX?: number;
  scaleY?: number;
}

/** Export settings captured at save time, replayed when re-editing. */
export interface ImageEditSettings {
  crop?: ImageCrop;
  maxWidth?: number;
  quality?: number;
  format?: string;
}

/** The cached original bytes (as a data URL) plus the settings used. */
export interface CachedOriginal {
  dataUrl: string;
  settings: ImageEditSettings;
}

function keyFor(absPath: string): string {
  const normalized = path.resolve(absPath).toLowerCase();
  return crypto.createHash("sha1").update(normalized).digest("hex");
}

/** Persist the pristine source + the settings used to produce the saved file. */
export function storeOriginal(
  absPath: string,
  originalDataUrl: string,
  settings: ImageEditSettings,
): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const key = keyFor(absPath);
    fs.writeFileSync(path.join(CACHE_DIR, `${key}.dataurl`), originalDataUrl);
    fs.writeFileSync(
      path.join(CACHE_DIR, `${key}.json`),
      JSON.stringify(settings ?? {}),
    );
  } catch {
    // Best-effort cache; never block a save on it.
  }
}

/** Return the cached original + settings for a saved image, if available. */
export function loadOriginal(absPath: string): CachedOriginal | null {
  try {
    const key = keyFor(absPath);
    const dataUrl = fs.readFileSync(
      path.join(CACHE_DIR, `${key}.dataurl`),
      "utf8",
    );
    if (!dataUrl) return null;
    let settings: ImageEditSettings = {};
    try {
      settings = JSON.parse(
        fs.readFileSync(path.join(CACHE_DIR, `${key}.json`), "utf8"),
      ) as ImageEditSettings;
    } catch {
      // Settings are optional — fall back to defaults.
    }
    return { dataUrl, settings };
  } catch {
    return null;
  }
}
