// build-app.js
import { build } from "esbuild";
import path from "path";
import fs from "fs";

const cwd = process.cwd();
const ENTRY = path.resolve(cwd, "app.js");
const OUTFILE = path.resolve(cwd, "static", "app.js");
const OUTDIR = path.dirname(OUTFILE);
const SHIM = path.resolve(cwd, "shims", "buffer-globals.js");
const inject = fs.existsSync(SHIM) ? [SHIM] : [];

// Ignore accidental CSS imports in the runtime bundle
const IgnoreCssPlugin = {
  name: "ignore-css",
  setup(b) {
    b.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
  }
};

async function ensureDir(dirPath) {
  try {
    await fs.promises.mkdir(dirPath, { recursive: true });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
}

async function run() {
  if (!fs.existsSync(ENTRY)) {
    console.error(`[TREATZ] ✖ Entry not found: ${ENTRY}`);
    process.exit(1);
  }
  await ensureDir(OUTDIR);

  console.log("[TREATZ] 🧩 esbuild bundling app.js → static/app.js");
  try {
    await build({
      entryPoints: [ENTRY],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: ["es2020"],
      minify: true,
      sourcemap: process.env.NODE_ENV === "development" ? "inline" : false,
      outfile: OUTFILE,

      define: {
        "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "production"),
        global: "globalThis"
      },

      // Make imported assets predictable and served from /static
      assetNames: "assets/[name]-[hash]",
      publicPath: "/static",
      loader: {
        ".svg": "dataurl",
        ".png": "file",
        ".jpg": "file",
        ".jpeg": "file",
        ".gif": "file",
        ".webp": "file",
        ".woff": "file",
        ".woff2": "file",
        ".mp3": "file"
      },

      // Optional Buffer/process shim (if present)
      inject,

      plugins: [IgnoreCssPlugin],
      logLevel: "info",
      legalComments: "none",
      conditions: ["browser", "module", "default"]
    });

    console.log("[TREATZ] ✅ Bundled to static/app.js");
    process.exit(0);
  } catch (err) {
    console.error("[TREATZ] ✖ esbuild failed");
    console.error(err);
    process.exit(1);
  }
}

run();