import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { findNamedContentRoot } from "../contentRoot";
import { isMarkdownEditor } from "../markdown";

export interface DocsToolsContext {
  enabled: boolean;
  contentRoot: string | null;
  filePath: string | null;
  fileName: string | null;
  /**
   * Human-friendly project name shown as the heading: the GitHub repo name
   * when the file lives in a git repo with a remote, otherwise the name of the
   * content root's parent folder.
   */
  name: string | null;
  reason: string;
}

/** Walk up from `startDir` to find the nearest `.git` (dir or worktree file). */
function findGitPath(startDir: string): string | null {
  let cursor = startDir;
  for (;;) {
    const gitPath = path.join(cursor, ".git");
    if (fs.existsSync(gitPath)) return gitPath;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

/** Resolve the path to the git `config` file from a `.git` dir or worktree file. */
function resolveGitConfigPath(gitPath: string): string | null {
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) return path.join(gitPath, "config");
    // Worktree/submodule: `.git` is a file with `gitdir: <path>`.
    const m = fs.readFileSync(gitPath, "utf8").match(/gitdir:\s*(.+)/);
    if (!m) return null;
    const resolved = path.resolve(path.dirname(gitPath), m[1].trim());
    return path.join(resolved, "config");
  } catch {
    return null;
  }
}

/** Extract the repo name (last path segment, sans `.git`) from a remote URL. */
function repoNameFromUrl(url: string): string | null {
  const cleaned = url.trim().replace(/\.git$/, "");
  const m = cleaned.match(/[/:]([^/:]+)$/);
  return m ? m[1] : null;
}

/** Repo name from the git remote (prefers `origin`) for the file at `dir`. */
function gitRepoName(dir: string): string | null {
  const gitPath = findGitPath(dir);
  if (!gitPath) return null;
  const configPath = resolveGitConfigPath(gitPath);
  if (!configPath) return null;
  let config: string;
  try {
    config = fs.readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
  const originMatch = config.match(
    /\[remote "origin"\][^[]*?url\s*=\s*(.+)/s,
  );
  const anyUrl = config.match(/url\s*=\s*(.+)/);
  const url = (originMatch ?? anyUrl)?.[1];
  return url ? repoNameFromUrl(url) : null;
}

/** Project name: git repo name, falling back to the content root's parent folder. */
function projectName(contentRoot: string): string {
  return gitRepoName(contentRoot) ?? path.basename(path.dirname(contentRoot));
}

export function getDocsToolsContext(): DocsToolsContext {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isMarkdownEditor(editor)) {
    return {
      enabled: false,
      contentRoot: null,
      filePath: null,
      fileName: null,
      name: null,
      reason: "Open a Markdown or MDX file to use docs tools.",
    };
  }

  const filePath = editor.document.uri.fsPath;
  const contentDirNames = vscode.workspace
    .getConfiguration("fumadocs")
    .get<string[]>("contentDirNames", ["content"]);
  const contentRoot = findNamedContentRoot(filePath, contentDirNames);

  if (!contentRoot) {
    return {
      enabled: false,
      contentRoot: null,
      filePath,
      fileName: editor.document.fileName,
      name: null,
      reason: "No content root found — place the file under a configured content directory.",
    };
  }

  return {
    enabled: true,
    contentRoot,
    filePath,
    fileName: editor.document.fileName,
    name: projectName(contentRoot),
    reason: "",
  };
}
