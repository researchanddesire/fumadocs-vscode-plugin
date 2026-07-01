const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * Vendor Cropper.js assets into `media/vendor/` so the sidebar webview can
 * inline them (the webview has no bundler and `node_modules` isn't shipped).
 */
function copyCropperAssets() {
  const src = path.join(__dirname, "node_modules", "cropperjs", "dist");
  const dest = path.join(__dirname, "media", "vendor");
  fs.mkdirSync(dest, { recursive: true });
  for (const file of ["cropper.min.js", "cropper.min.css"]) {
    fs.copyFileSync(path.join(src, file), path.join(dest, file));
  }
}

async function main() {
  copyCropperAssets();

  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "info",
    loader: { ".json": "json" },
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
