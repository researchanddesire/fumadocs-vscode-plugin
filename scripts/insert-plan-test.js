const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "fumadocs-insert-plan-"));
const outfile = path.join(outdir, "insertPlan.cjs");

esbuild.buildSync({
  entryPoints: [path.join(root, "src/docsTools/insertPlan.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile,
  logLevel: "silent",
});

const { createBlockInsertionPlan, prepareMdxBlock } = require(outfile);

function lines(text) {
  return text.split("\n").map((line) => ({ text: line }));
}

function applyPlan(source, plan) {
  const sourceLines = source.split("\n");
  const beforeLines = sourceLines.slice(0, plan.range.start.line);
  const afterLines = sourceLines.slice(plan.range.end.line);
  const line = sourceLines[plan.range.start.line] || "";
  const before = line.slice(0, plan.range.start.character);
  const after = line.slice(plan.range.end.character);
  const replacement = `${before}${plan.text}${after}`;
  return beforeLines.concat(replacement.split("\n"), afterLines.slice(1)).join("\n");
}

{
  const source = [
    "<Callout>",
    "",
    "Keep this callout intact.",
    "",
    "</Callout>",
  ].join("\n");
  const accordion = [
    "<Accordions type=\"single\">",
    "  <Accordion title=\"Question\">",
    "",
    "Answer goes here.",
    "",
    "  </Accordion>",
    "</Accordions>",
  ].join("\n");

  const plan = createBlockInsertionPlan(lines(source), 4, accordion);
  const result = applyPlan(source, plan);

  assert.match(result, /<\/Callout>\n\n<Accordions/);
  assert.equal((result.match(/<\/Callout>/g) || []).length, 1);
  assert.equal((result.match(/<Accordions/g) || []).length, 1);
}

{
  const source = ["Intro text", "selected text", "more text"].join("\n");
  const snippet = "<Callout>\n\nHello\n\n</Callout>";
  const plan = createBlockInsertionPlan(lines(source), 1, snippet);
  const result = applyPlan(source, plan);

  assert.match(result, /selected text/);
  assert.match(result, /more text\n\n<Callout>/);
}

{
  const source = [
    "```tsx",
    "<Callout>",
    "inside code",
    "</Callout>",
    "```",
    "",
    "After",
  ].join("\n");
  const plan = createBlockInsertionPlan(lines(source), 1, "<Cards>\n</Cards>");
  const result = applyPlan(source, plan);

  assert.match(result, /```\n\n<Cards>/);
}

{
  const messy = "  <Callout>  \r\n\r\n\r\nBody   \r\n\r\n</Callout>  \r\n";
  assert.equal(prepareMdxBlock(messy), "<Callout>\n\nBody\n\n</Callout>");
}

fs.rmSync(outdir, { recursive: true, force: true });
console.log("insert plan tests passed");
