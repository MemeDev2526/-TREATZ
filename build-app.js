// build-app.js
// Bundles root-level app.js → static/app.js using esbuild
// Place this file in repo root (next to app.js). Run: node build-app.js

import { build } from 'esbuild';
import path from 'path';
import fs from 'fs';

const cwd = process.cwd();
const ENTRY = path.resolve(cwd, 'app.js');
const OUTFILE = path.resolve(cwd, 'static', 'app.js');

async function ensureDir(dirPath) {
  try {
    await fs.promises.mkdir(dirPath, { recursive: true });
  } catch (err) {
    // if dir exists concurrently, ignore
    if (err.code !== 'EEXIST') throw err;
  }
}

async function run() {
  if (!fs.existsSync(ENTRY)) {
    console.error(`[TREATZ] ✖ Entry not found: ${ENTRY}`);
    process.exit(1);
  }

  // ensure static/ exists
  await ensureDir(path.dirname(OUTFILE));

  console.log('[TREATZ] 🧩 esbuild bundling app.js → static/app.js');
  try {
    await build({
      entryPoints: [ENTRY],
      bundle: true,
      minify: true,
      sourcemap: false,
      platform: 'browser',
      target: ['es2020'],
      outfile: OUTFILE,
      // define environment
      define: {
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
      },
      // helpful loaders if your app imports assets or small svgs
      loader: {
        '.svg': 'dataurl',
        '.png': 'file',
        '.jpg': 'file',
        '.jpeg': 'file',
        '.gif': 'file',
        '.css': 'css',
      },
      logLevel: 'info',
      // If your code uses large libraries that you want to externalize, add "external" here.
      // external: ['some-cdn-lib'],
    });

    console.log('[TREATZ] ✅ Bundled to static/app.js');
    process.exit(0);
  } catch (err) {
    console.error('[TREATZ] ✖ esbuild failed');
    console.error(err);
    process.exit(1);
  }
}

run();
