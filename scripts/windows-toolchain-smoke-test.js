const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const devServer = read("src/devServer.ts");
const preview = read("src/preview.ts");
const extension = read("src/extension.ts");
const webappPackage = JSON.parse(read("webapp/package.json"));

assert.match(
  devServer,
  /node_modules[\s\S]*next[\s\S]*dist[\s\S]*bin[\s\S]*next/,
  "Next should be launched through its JS entrypoint",
);
assert.doesNotMatch(
  devServer,
  /const binName = process\.platform === "win32" \? "next\.cmd"/,
  "Windows should not launch next.cmd directly",
);
assert.match(
  devServer,
  /"ci",\s*"--ignore-scripts=false",\s*"--include=optional"/,
  "npm install should force scripts and optional dependencies",
);
assert.equal(
  webappPackage.allowScripts?.["sharp@0.34.5"],
  true,
  "webapp package should approve the locked sharp install script",
);
assert.match(preview, /data-action="repairSharp"/);
assert.match(preview, /data-action="copyExecutionPolicyCommands"/);
assert.match(preview, /data-action="showDiagnostics"/);
assert.match(extension, /fumadocs\.repairToolchain/);
assert.match(extension, /fumadocs\.copyWindowsScriptFix/);
assert.match(extension, /fumadocs\.showToolchainDiagnostics/);

console.log("Windows toolchain smoke checks passed.");
