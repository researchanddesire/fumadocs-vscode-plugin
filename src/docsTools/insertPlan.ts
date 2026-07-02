export interface TextLine {
  text: string;
}

export interface LineMeta {
  /** Whether the line is inside (or is the boundary of) a fenced code block. */
  inCode: boolean;
  /** Approx. JSX nesting depth at the start of the line. */
  depth: number;
  blank: boolean;
}

export interface PlanPosition {
  line: number;
  character: number;
}

export interface PlanRange {
  start: PlanPosition;
  end: PlanPosition;
}

export interface InsertionPlan {
  range: PlanRange;
  text: string;
  snippetStartLine: number;
  insertedRange: PlanRange;
}

interface InsertTarget {
  line: number;
  atEof: boolean;
}

/**
 * Tidy a generated snippet before it lands in the document: normalize line
 * endings, drop trailing whitespace, and collapse runs of blank lines to a
 * single separator while leaving fenced code blocks alone.
 */
export function prepareMdxBlock(snippet: string): string {
  const lines = snippet.replaceAll(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inCode = false;
  let pendingBlank = false;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const isFence = /^\s*(```|~~~)/.test(line);

    if (isFence) {
      if (pendingBlank && out.length > 0) out.push("");
      pendingBlank = false;
      out.push(line);
      inCode = !inCode;
      continue;
    }

    if (!inCode && line.trim() === "") {
      if (out.length > 0) pendingBlank = true;
      continue;
    }

    if (pendingBlank) out.push("");
    pendingBlank = false;
    out.push(line);
  }

  return out.join("\n").trim();
}

export function createBlockInsertionPlan(
  lines: readonly TextLine[],
  preferredLine: number,
  snippet: string,
): InsertionPlan {
  const safeLines = lines.length > 0 ? lines : [{ text: "" }];
  const meta = buildLineMeta(safeLines);
  const target = findSafeInsertLine(meta, safeLines, preferredLine);
  const block = prepareMdxBlock(snippet);
  return buildEdit(safeLines, target, block);
}

function buildLineMeta(lines: readonly TextLine[]): LineMeta[] {
  const meta: LineMeta[] = [];
  let inCode = false;
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text;
    meta.push({ inCode, depth, blank: text.trim() === "" });

    const isFence = /^\s*(```|~~~)/.test(text);
    if (isFence) {
      inCode = !inCode;
      continue;
    }
    if (!inCode) {
      depth = Math.max(0, depth + jsxDelta(text));
    }
  }
  return meta;
}

/** Net change in JSX element depth contributed by a single line. */
function jsxDelta(line: string): number {
  let delta = 0;
  const opens = line.match(/<[A-Za-z][\w.]*(\s[^<>]*?)?>/g) || [];
  for (const tag of opens) {
    if (!tag.endsWith("/>")) delta++;
  }
  const closes = line.match(/<\/[A-Za-z][\w.]*>/g) || [];
  delta -= closes.length;
  return delta;
}

function findSafeInsertLine(
  meta: readonly LineMeta[],
  lines: readonly TextLine[],
  preferredLine: number,
): InsertTarget {
  const lineCount = lines.length;
  let i = Math.min(Math.max(preferredLine, 0), lineCount - 1);

  while (i < lineCount && meta[i].inCode) i++;

  for (let j = i; j < lineCount; j++) {
    const m = meta[j];
    if (m.blank && !m.inCode && m.depth === 0) {
      return { line: j, atEof: false };
    }
  }
  return { line: lineCount - 1, atEof: true };
}

function buildEdit(
  lines: readonly TextLine[],
  target: InsertTarget,
  block: string,
): InsertionPlan {
  if (target.atEof) {
    const lastLine = lines.length - 1;
    const lastText = lines[lastLine].text;
    const prefix = lastText.trim() === "" ? "\n" : "\n\n";
    const pos = { line: lastLine, character: lastText.length };
    const text = `${prefix}${block}\n`;
    const snippetStartLine = lastLine + countNewlines(prefix);
    return {
      range: { start: pos, end: pos },
      text,
      snippetStartLine,
      insertedRange: insertedRange(snippetStartLine, block),
    };
  }

  const i = target.line;
  const needLeadingBlank = i > 0 && lines[i - 1].text.trim() !== "";
  const text = `${needLeadingBlank ? "\n" : ""}${block}\n`;
  const pos = { line: i, character: 0 };
  const snippetStartLine = i + (needLeadingBlank ? 1 : 0);
  return {
    range: { start: pos, end: pos },
    text,
    snippetStartLine,
    insertedRange: insertedRange(snippetStartLine, block),
  };
}

function insertedRange(snippetStartLine: number, block: string): PlanRange {
  const blockLines = block.split("\n");
  const endLine = snippetStartLine + blockLines.length - 1;
  const endChar = (blockLines.at(-1) ?? "").length;
  return {
    start: { line: snippetStartLine, character: 0 },
    end: { line: endLine, character: endChar },
  };
}

function countNewlines(text: string): number {
  return (text.match(/\n/g) || []).length;
}
