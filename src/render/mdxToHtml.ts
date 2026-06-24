import MarkdownIt from "markdown-it";
import { detectConversions, Conversion } from "../convert/detectors";

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: false,
});

export interface RenderResult {
  title?: string;
  description?: string;
  html: string;
}

/**
 * Optional hook used by the webview to turn a relative image path into a URI it
 * is allowed to load (vscode `asWebviewUri`). Returns the original src when no
 * resolver is supplied or when the src is absolute / remote.
 */
export type ImageResolver = (src: string) => string;

interface FieldRange {
  value: string;
  start: number;
  end: number;
}

interface Frontmatter {
  title?: FieldRange;
  description?: FieldRange;
  body: string;
  /** Number of characters consumed by the frontmatter block (0 if none). */
  frontmatterLength: number;
}

const stripFrontmatter = (text: string): Frontmatter => {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) {
    return { body: text, frontmatterLength: 0 };
  }

  const block = match[1];
  const frontmatterLength = match[0].length;
  const body = text.slice(frontmatterLength);
  const blockOffset = match[0].indexOf(block);

  const readField = (field: string): FieldRange | undefined => {
    const fieldMatch = new RegExp(`^${field}:[ \\t]*(.*)$`, "m").exec(block);
    if (!fieldMatch) {
      return undefined;
    }
    const raw = fieldMatch[1];
    const start = blockOffset + fieldMatch.index + (fieldMatch[0].length - raw.length);
    return { value: raw, start, end: start + raw.length };
  };

  return {
    title: readField("title"),
    description: readField("description"),
    body,
    frontmatterLength,
  };
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const getAttr = (attrs: string, name: string): string | undefined => {
  const doubleQuoted = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  if (doubleQuoted) {
    return doubleQuoted[1];
  }
  const singleQuoted = new RegExp(`${name}\\s*=\\s*'([^']*)'`).exec(attrs);
  if (singleQuoted) {
    return singleQuoted[1];
  }
  // Boolean prop, e.g. `defaultOpen`.
  if (new RegExp(`(^|\\s)${name}(\\s|$|=)`).test(attrs)) {
    return "";
  }
  return undefined;
};

/**
 * Remove the common leading indentation from a block so authors can indent
 * content inside components without markdown-it treating it as a code block.
 */
const dedent = (text: string): string => {
  const lines = text.replace(/^\n+|\s+$/g, "").split("\n");
  let min = Infinity;
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const leading = /^[ \t]*/.exec(line)?.[0].length ?? 0;
    min = Math.min(min, leading);
  }
  if (!Number.isFinite(min) || min === 0) {
    return lines.join("\n");
  }
  return lines.map((line) => line.slice(min)).join("\n");
};

/**
 * Wrap component inner content so markdown-it treats the opening/closing tags as
 * their own HTML blocks and renders the markdown in between. The blank lines are
 * essential — without them markdown-it passes the inner content through raw.
 */
const block = (open: string, inner: string, close: string): string =>
  `\n\n${open}\n\n${dedent(inner)}\n\n${close}\n\n`;

type Replacer = (text: string) => string;

const calloutType = (raw?: string): string => {
  const value = (raw ?? "info").toLowerCase();
  return ["info", "warn", "error", "success"].includes(value) ? value : "info";
};

/**
 * Ordered list of component transforms. Children (leaf / inner) components are
 * converted before their containers so non-greedy regexes capture already-HTML
 * inner content. This is best-effort; deeply nested same-name trees may render
 * loosely, which is acceptable for an approximate preview.
 */
const replacers: Replacer[] = [
  // --- Self-closing leaves -------------------------------------------------
  // <ImageZoom src alt /> -> img
  (text) =>
    text.replace(/<ImageZoom\b([^>]*?)\/>/g, (_m, attrs: string) => {
      const src = getAttr(attrs, "src") ?? "";
      const alt = getAttr(attrs, "alt") ?? "";
      return `\n\n<img class="fd-image" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" />\n\n`;
    }),
  // <File name /> -> file row
  (text) =>
    text.replace(/<File\b([^>]*?)\/>/g, (_m, attrs: string) => {
      const name = getAttr(attrs, "name") ?? "file";
      return `<div class="fd-file"><span class="fd-file-icon">📄</span>${escapeHtml(name)}</div>`;
    }),
  // <Card ... /> (self-closing) -> anchor card
  (text) =>
    text.replace(/<Card\b([^>]*?)\/>/g, (_m, attrs: string) =>
      cardHtml(attrs, ""),
    ),
  // <TypeTable type={{...}} /> -> note (object props not rendered in preview)
  (text) =>
    text.replace(/<TypeTable\b[\s\S]*?\/>/g, () =>
      noteHtml("Type table", "Properties table renders in the published docs."),
    ),
  // <InlineTOC items={...} /> -> note
  (text) =>
    text.replace(/<InlineTOC\b[^>]*?\/>/g, () =>
      noteHtml("Inline table of contents", "Generated from page headings."),
    ),

  // --- Paired leaf-ish components -----------------------------------------
  // <Card>...</Card>
  (text) =>
    text.replace(
      /<Card\b([^>]*)>([\s\S]*?)<\/Card>/g,
      (_m, attrs: string, inner: string) => cardHtml(attrs, inner),
    ),
  // <Tab value>...</Tab>
  (text) =>
    text.replace(
      /<Tab\b([^>]*)>([\s\S]*?)<\/Tab>/g,
      (_m, attrs: string, inner: string) => {
        const value = getAttr(attrs, "value") ?? "Tab";
        return block(
          `<div class="fd-tab"><div class="fd-tab-label">${escapeHtml(value)}</div><div class="fd-tab-body">`,
          inner,
          `</div></div>`,
        );
      },
    ),
  // <Step>...</Step>
  (text) =>
    text.replace(/<Step\b[^>]*>([\s\S]*?)<\/Step>/g, (_m, inner: string) =>
      block(`<div class="fd-step">`, inner, `</div>`),
    ),
  // <Accordion title>...</Accordion>
  (text) =>
    text.replace(
      /<Accordion\b([^>]*)>([\s\S]*?)<\/Accordion>/g,
      (_m, attrs: string, inner: string) => {
        const title = getAttr(attrs, "title") ?? "Details";
        return block(
          `<details class="fd-accordion" open><summary>${escapeHtml(title)}</summary><div class="fd-accordion-body">`,
          inner,
          `</div></details>`,
        );
      },
    ),
  // <Folder name>...</Folder>
  (text) =>
    text.replace(
      /<Folder\b([^>]*)>([\s\S]*?)<\/Folder>/g,
      (_m, attrs: string, inner: string) => {
        const name = getAttr(attrs, "name") ?? "folder";
        return (
          `<div class="fd-folder"><div class="fd-folder-name"><span class="fd-file-icon">📁</span>${escapeHtml(name)}</div>` +
          `<div class="fd-folder-body">${inner.trim()}</div></div>`
        );
      },
    ),

  // --- Containers ----------------------------------------------------------
  // <Tabs items={[...]}>...</Tabs>
  (text) =>
    text.replace(
      /<Tabs\b([^>]*)>([\s\S]*?)<\/Tabs>/g,
      (_m, attrs: string, inner: string) => {
        const items = getAttr(attrs, "items");
        const labels = items
          ? Array.from(items.matchAll(/['"]([^'"]+)['"]/g)).map((x) => x[1])
          : [];
        const header = labels.length
          ? `<div class="fd-tabs-header">${labels
              .map(
                (label, i) =>
                  `<span class="fd-tabs-tab${i === 0 ? " active" : ""}">${escapeHtml(label)}</span>`,
              )
              .join("")}</div>`
          : "";
        return block(`<div class="fd-tabs">${header}`, inner, `</div>`);
      },
    ),
  // <Steps>...</Steps>
  (text) =>
    text.replace(/<Steps\b[^>]*>([\s\S]*?)<\/Steps>/g, (_m, inner: string) =>
      block(`<div class="fd-steps">`, inner, `</div>`),
    ),
  // <Accordions>...</Accordions>
  (text) =>
    text.replace(
      /<Accordions\b[^>]*>([\s\S]*?)<\/Accordions>/g,
      (_m, inner: string) => block(`<div class="fd-accordions">`, inner, `</div>`),
    ),
  // <Files>...</Files>
  (text) =>
    text.replace(/<Files\b[^>]*>([\s\S]*?)<\/Files>/g, (_m, inner: string) =>
      `\n\n<div class="fd-files">${inner.trim()}</div>\n\n`,
    ),
  // <Cards>...</Cards>
  (text) =>
    text.replace(/<Cards\b[^>]*>([\s\S]*?)<\/Cards>/g, (_m, inner: string) =>
      `\n\n<div class="fd-cards">${inner.trim()}</div>\n\n`,
    ),
  // <Banner>...</Banner>
  (text) =>
    text.replace(
      /<Banner\b([^>]*)>([\s\S]*?)<\/Banner>/g,
      (_m, attrs: string, inner: string) => {
        const variant = getAttr(attrs, "variant") ?? "normal";
        return block(
          `<div class="fd-banner fd-banner-${escapeHtml(variant)}">`,
          inner,
          `</div>`,
        );
      },
    ),
  // <Callout type title>...</Callout>
  (text) =>
    text.replace(
      /<Callout\b([^>]*)>([\s\S]*?)<\/Callout>/g,
      (_m, attrs: string, inner: string) => {
        const type = calloutType(getAttr(attrs, "type"));
        const title = getAttr(attrs, "title");
        const titleHtml = title
          ? `<div class="fd-callout-title">${escapeHtml(title)}</div>`
          : "";
        return block(
          `<div class="fd-callout fd-callout-${type}"><div class="fd-callout-icon"></div><div class="fd-callout-content">${titleHtml}`,
          inner,
          `</div></div>`,
        );
      },
    ),
];

const cardHtml = (attrs: string, inner: string): string => {
  const title = getAttr(attrs, "title") ?? "Card";
  const href = getAttr(attrs, "href") ?? "#";
  const description = getAttr(attrs, "description") ?? inner.trim();
  const descHtml = description
    ? `<div class="fd-card-desc">${escapeHtml(description)}</div>`
    : "";
  return `<a class="fd-card" href="${escapeHtml(href)}"><div class="fd-card-title">${escapeHtml(title)}</div>${descHtml}</a>`;
};

const noteHtml = (title: string, body: string): string =>
  `\n\n<div class="fd-note"><strong>${escapeHtml(title)}</strong><div>${escapeHtml(body)}</div></div>\n\n`;

const transformComponents = (body: string): string =>
  replacers.reduce((acc, replace) => replace(acc), body);

const rewriteImages = (html: string, resolve?: ImageResolver): string => {
  if (!resolve) {
    return html;
  }
  return html.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*")([^"]+)(")/g,
    (_m, pre: string, src: string, post: string) =>
      `${pre}${resolve(src)}${post}`,
  );
};

// --- Block splitting (gives every chunk an exact source range) -------------

interface SourceLine {
  text: string;
  start: number;
  end: number;
}

interface SourceBlock {
  /** Offset within the body. */
  start: number;
  end: number;
  raw: string;
  /** Component name when the block is a single JSX component, else undefined. */
  component?: string;
}

const ADD_ITEM_CONTAINERS = new Set([
  "Steps",
  "Cards",
  "Accordions",
  "Tabs",
  "Files",
]);

const bodyLines = (body: string): SourceLine[] => {
  const lines: SourceLine[] = [];
  let offset = 0;
  for (const raw of body.split("\n")) {
    lines.push({ text: raw, start: offset, end: offset + raw.length });
    offset += raw.length + 1;
  }
  return lines;
};

const componentNameAt = (line: string): string | undefined => {
  const match = /^\s*<([A-Z][A-Za-z0-9]*)/.exec(line);
  return match ? match[1] : undefined;
};

/** Walk forward from a component opening line to its balanced closing line. */
const componentEndLine = (lines: SourceLine[], startIdx: number, name: string): number => {
  const open = new RegExp(`<${name}\\b`, "g");
  const close = new RegExp(`</${name}>`, "g");
  const selfClose = new RegExp(`<${name}\\b[^>]*/>`, "g");
  let depth = 0;
  for (let i = startIdx; i < lines.length; i++) {
    const text = lines[i].text;
    const opens = (text.match(open) ?? []).length;
    const closes = (text.match(close) ?? []).length;
    const selfs = (text.match(selfClose) ?? []).length;
    depth += opens - selfs - closes;
    if (i >= startIdx && depth <= 0) {
      return i;
    }
  }
  return lines.length - 1;
};

const splitBlocks = (body: string): SourceBlock[] => {
  const lines = bodyLines(body);
  const blocks: SourceBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.text.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block: keep intact (may contain blank lines).
    if (/^\s*(```|~~~)/.test(line.text)) {
      const fence = /^\s*(```|~~~)/.exec(line.text)?.[1] ?? "```";
      let j = i + 1;
      while (j < lines.length && !lines[j].text.includes(fence)) {
        j++;
      }
      const end = Math.min(j, lines.length - 1);
      blocks.push({
        start: line.start,
        end: lines[end].end,
        raw: body.slice(line.start, lines[end].end),
      });
      i = end + 1;
      continue;
    }

    // Component block.
    const name = componentNameAt(line.text);
    if (name) {
      const end = componentEndLine(lines, i, name);
      blocks.push({
        start: line.start,
        end: lines[end].end,
        raw: body.slice(line.start, lines[end].end),
        component: name,
      });
      i = end + 1;
      continue;
    }

    // Markdown block: consecutive non-blank lines that do not start a component.
    const startLine = i;
    while (
      i < lines.length &&
      lines[i].text.trim() !== "" &&
      !componentNameAt(lines[i].text) &&
      !/^\s*(```|~~~)/.test(lines[i].text)
    ) {
      i++;
    }
    const end = i - 1;
    blocks.push({
      start: lines[startLine].start,
      end: lines[end].end,
      raw: body.slice(lines[startLine].start, lines[end].end),
    });
  }

  return blocks;
};

const renderFragment = (raw: string): string =>
  md.render(transformComponents(raw));

const dataAttr = (name: string, value: string | number): string =>
  ` ${name}="${typeof value === "number" ? value : encodeURIComponent(value)}"`;

const blockTools = (options: {
  conversion?: Conversion;
  component?: string;
}): string => {
  const codeIcon =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>';
  const buttons: string[] = [];
  buttons.push(
    `<button class="fd-tool fd-tool-edit" title="Edit Markdown source">${codeIcon}</button>`,
  );

  if (options.conversion) {
    buttons.push(
      `<button class="fd-tool fd-tool-convert"` +
        dataAttr("data-conv-start", options.conversion.start) +
        dataAttr("data-conv-end", options.conversion.end) +
        dataAttr("data-conv-text", options.conversion.replacement) +
        `>${options.conversion.title}</button>`,
    );
  }

  if (options.component && ADD_ITEM_CONTAINERS.has(options.component)) {
    const labelMap: Record<string, string> = {
      Steps: "+ Add step",
      Cards: "+ Add card",
      Accordions: "+ Add section",
      Tabs: "+ Add tab",
      Files: "+ Add file",
    };
    buttons.push(
      `<button class="fd-tool fd-tool-add"` +
        dataAttr("data-add", options.component) +
        `>${labelMap[options.component]}</button>`,
    );
  }

  return `<div class="fd-tools">${buttons.join("")}</div>`;
};

const wrapBlock = (options: {
  absStart: number;
  absEnd: number;
  raw: string;
  content: string;
  component?: string;
  conversion?: Conversion;
}): string =>
  `<div class="fd-block"${dataAttr("data-src-start", options.absStart)}` +
  dataAttr("data-src-end", options.absEnd) +
  dataAttr("data-raw", options.raw) +
  (options.component ? dataAttr("data-component", options.component) : "") +
  `>${blockTools({ conversion: options.conversion, component: options.component })}` +
  `<div class="fd-block-content">${options.content}</div></div>`;

const renderHeaderField = (
  field: FieldRange | undefined,
  className: string,
  placeholder: string,
): string => {
  if (!field) {
    return "";
  }
  const display = field.value.replace(/^["']|["']$/g, "") || placeholder;
  return (
    `<div class="fd-block ${className}"` +
    dataAttr("data-src-start", field.start) +
    dataAttr("data-src-end", field.end) +
    dataAttr("data-raw", field.value) +
    `><div class="fd-block-content">${escapeHtml(display)}</div></div>`
  );
};

export const renderMdx = (
  text: string,
  resolveImage?: ImageResolver,
): RenderResult => {
  const { title, description, body, frontmatterLength } = stripFrontmatter(text);
  const conversions = detectConversions(text);
  const blocks = splitBlocks(body);

  const parts: string[] = [];
  parts.push(renderHeaderField(title, "fd-page-title", "Untitled"));
  parts.push(renderHeaderField(description, "fd-page-description", ""));

  for (const blockItem of blocks) {
    const absStart = frontmatterLength + blockItem.start;
    const absEnd = frontmatterLength + blockItem.end;
    const conversion = conversions.find(
      (c) => c.start >= absStart && c.start < absEnd,
    );
    parts.push(
      wrapBlock({
        absStart,
        absEnd,
        raw: blockItem.raw,
        content: renderFragment(blockItem.raw),
        component: blockItem.component,
        conversion,
      }),
    );
  }

  const html = rewriteImages(parts.join("\n"), resolveImage);
  return {
    title: title?.value.replace(/^["']|["']$/g, ""),
    description: description?.value.replace(/^["']|["']$/g, ""),
    html,
  };
};

/**
 * Insert a new child into a component container's source text. Returns the
 * updated container source, or null when the container/closing tag is missing.
 */
export const addChildToContainer = (
  source: string,
  container: string,
): string | null => {
  const close = `</${container}>`;
  const lines = source.split("\n");
  let closeIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(close)) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return null;
  }

  const containerIndent = /^\s*/.exec(lines[0])?.[0] ?? "";
  const childIndent = `${containerIndent}  `;

  const templates: Record<string, string[]> = {
    Steps: ["<Step>", "  ### New step", "  Describe this step.", "</Step>"],
    Cards: ['<Card title="New card" href="/" />'],
    Accordions: [
      '<Accordion title="New question">',
      "  Answer goes here.",
      "</Accordion>",
    ],
    Tabs: ['<Tab value="New tab">', "  Tab content.", "</Tab>"],
    Files: ['<File name="new-file.ts" />'],
  };

  const template = templates[container];
  if (!template) {
    return null;
  }

  const childLines = template.map((entry) => `${childIndent}${entry}`);
  lines.splice(closeIdx, 0, ...childLines);
  return lines.join("\n");
};
