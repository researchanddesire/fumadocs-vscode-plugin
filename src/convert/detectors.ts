type ConversionKind = "steps" | "callout" | "cards";

export interface Conversion {
  kind: ConversionKind;
  /** Short label shown on the lightbulb / quick fix. */
  title: string;
  /** Message shown as the Hint diagnostic. */
  message: string;
  /** Inclusive start offset in the document. */
  start: number;
  /** Exclusive end offset in the document. */
  end: number;
  /** Text to replace [start, end) with. */
  replacement: string;
}

interface Line {
  text: string;
  start: number;
  end: number;
}

const toLines = (text: string): Line[] => {
  const lines: Line[] = [];
  let offset = 0;
  for (const raw of text.split("\n")) {
    lines.push({ text: raw, start: offset, end: offset + raw.length });
    offset += raw.length + 1; // +1 for the consumed "\n"
  }
  return lines;
};

const indent = (line: string): string => /^\s*/.exec(line)?.[0] ?? "";

const ADMONITION_MAP: Record<string, { type: string; title: string }> = {
  NOTE: { type: "info", title: "Note" },
  INFO: { type: "info", title: "Info" },
  TIP: { type: "success", title: "Tip" },
  SUCCESS: { type: "success", title: "Success" },
  WARNING: { type: "warn", title: "Warning" },
  CAUTION: { type: "warn", title: "Caution" },
  IMPORTANT: { type: "error", title: "Important" },
  DANGER: { type: "error", title: "Danger" },
  ERROR: { type: "error", title: "Error" },
};

/**
 * Build a set of line indexes that sit inside fenced code blocks (``` or ~~~)
 * or the leading YAML frontmatter, so detectors never fire there.
 */
const blockedLines = (lines: Line[]): Set<number> => {
  const blocked = new Set<number>();
  let inFence = false;
  let inFrontmatter = false;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text;
    if (i === 0 && /^---\s*$/.test(text)) {
      inFrontmatter = true;
      blocked.add(i);
      continue;
    }
    if (inFrontmatter) {
      blocked.add(i);
      if (/^---\s*$/.test(text)) {
        inFrontmatter = false;
      }
      continue;
    }
    if (/^\s*(```|~~~)/.test(text)) {
      blocked.add(i);
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      blocked.add(i);
    }
  }
  return blocked;
};

const detectSteps = (
  lines: Line[],
  blocked: Set<number>,
  conversions: Conversion[],
): void => {
  let i = 0;
  while (i < lines.length) {
    if (blocked.has(i) || !/^\s*\d+\.\s+\S/.test(lines[i].text)) {
      i++;
      continue;
    }

    // Collect a contiguous numbered list: item lines + indented continuations.
    const startLine = i;
    const items: string[] = [];
    while (i < lines.length && !blocked.has(i)) {
      const text = lines[i].text;
      const itemMatch = /^\s*\d+\.\s+(.*)$/.exec(text);
      if (itemMatch) {
        items.push(itemMatch[1].trim());
        i++;
        continue;
      }
      // Indented continuation line belongs to the previous item.
      if (items.length > 0 && /^\s+\S/.test(text)) {
        items[items.length - 1] += "\n" + text.trim();
        i++;
        continue;
      }
      break;
    }
    const endLine = i - 1;

    if (items.length < 2) {
      continue;
    }

    const pad = indent(lines[startLine].text);
    const body = items
      .map(
        (item) =>
          `${pad}  <Step>\n${item
            .split("\n")
            .map((part) => `${pad}    ${part}`)
            .join("\n")}\n${pad}  </Step>`,
      )
      .join("\n");
    const replacement = `${pad}<Steps>\n${body}\n${pad}</Steps>`;

    conversions.push({
      kind: "steps",
      title: "Convert numbered list to <Steps>",
      message:
        "This looks like a numbered list. Convert it to a Fumadocs <Steps> component?",
      start: lines[startLine].start,
      end: lines[endLine].end,
      replacement,
    });
  }
};

const detectCallouts = (
  lines: Line[],
  blocked: Set<number>,
  conversions: Conversion[],
): void => {
  let i = 0;
  while (i < lines.length) {
    if (blocked.has(i) || !/^\s*>\s?/.test(lines[i].text)) {
      i++;
      continue;
    }

    const startLine = i;
    const contentLines: string[] = [];
    while (i < lines.length && !blocked.has(i) && /^\s*>\s?/.test(lines[i].text)) {
      contentLines.push(lines[i].text.replace(/^\s*>\s?/, ""));
      i++;
    }
    const endLine = i - 1;

    let type = "info";
    let title: string | undefined;
    const admonition = /^\s*\[!(\w+)\]\s*(.*)$/.exec(contentLines[0] ?? "");
    if (admonition) {
      const mapped = ADMONITION_MAP[admonition[1].toUpperCase()];
      if (mapped) {
        type = mapped.type;
        title = mapped.title;
      }
      const rest = admonition[2].trim();
      contentLines[0] = rest;
      if (!rest) {
        contentLines.shift();
      }
    }

    const pad = indent(lines[startLine].text);
    const inner = contentLines
      .map((line) => `${pad}  ${line}`.trimEnd())
      .join("\n");
    const open = title
      ? `${pad}<Callout type="${type}" title="${title}">`
      : `${pad}<Callout type="${type}">`;
    const replacement = `${open}\n${inner}\n${pad}</Callout>`;

    conversions.push({
      kind: "callout",
      title: "Convert quote to <Callout>",
      message:
        "This blockquote can become a Fumadocs <Callout> for a nicer highlighted box.",
      start: lines[startLine].start,
      end: lines[endLine].end,
      replacement,
    });
  }
};

const detectCards = (
  lines: Line[],
  blocked: Set<number>,
  conversions: Conversion[],
): void => {
  const linkBullet = /^\s*[-*]\s+\[([^\]]+)\]\(([^)]+)\)\s*$/;
  let i = 0;
  while (i < lines.length) {
    if (blocked.has(i) || !linkBullet.test(lines[i].text)) {
      i++;
      continue;
    }

    const startLine = i;
    const cards: { title: string; href: string }[] = [];
    while (i < lines.length && !blocked.has(i)) {
      const match = linkBullet.exec(lines[i].text);
      if (!match) {
        break;
      }
      cards.push({ title: match[1].trim(), href: match[2].trim() });
      i++;
    }
    const endLine = i - 1;

    if (cards.length < 2) {
      continue;
    }

    const pad = indent(lines[startLine].text);
    const body = cards
      .map(
        (card) =>
          `${pad}  <Card title="${card.title}" href="${card.href}" />`,
      )
      .join("\n");
    const replacement = `${pad}<Cards>\n${body}\n${pad}</Cards>`;

    conversions.push({
      kind: "cards",
      title: "Convert link list to <Cards>",
      message:
        "This list of links can become a Fumadocs <Cards> grid.",
      start: lines[startLine].start,
      end: lines[endLine].end,
      replacement,
    });
  }
};

export const detectConversions = (text: string): Conversion[] => {
  const lines = toLines(text);
  const blocked = blockedLines(lines);
  const conversions: Conversion[] = [];
  detectSteps(lines, blocked, conversions);
  detectCallouts(lines, blocked, conversions);
  detectCards(lines, blocked, conversions);
  return conversions.sort((a, b) => a.start - b.start);
};
