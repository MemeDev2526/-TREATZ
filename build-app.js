// build-app.js
import { build } from 'esbuild';
import path from 'path';
import fs from 'fs';

const cwd = process.cwd();
const ENTRY = path.resolve(cwd, 'app.js');
const OUTFILE = path.resolve(cwd, 'static', 'app.js');

// One plugin, defined once (ignore any accidental CSS imports)
const IgnoreCssPlugin = {
  name: 'ignore-css',
  setup(b) {
    b.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
  }
};

async function ensureDir(dirPath) {
  try { await fs.promises.mkdir(dirPath, { recursive: true }); }
  catch (err) { if (err.code !== 'EEXIST') throw err; }
}

async function run() {
  if (!fs.existsSync(ENTRY)) {
    console.error(`[TREATZ] ✖ Entry not found: ${ENTRY}`);
    process.exit(1);
  }
  await ensureDir(path.dirname(OUTFILE));

  console.log('[TREATZ] 🧩 esbuild bundling app.js → static/app.js');
  try {
    await build({
      entryPoints: [ENTRY],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2022'], // ← modern features (BigInt, optional catch bindings, etc.)
      minify: true,
      sourcemap: false,
      outfile: OUTFILE,
      define: {
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
        'global': 'window' // ← satisfy libs that reference `global` at parse-time
      },
      loader: {
        '.svg': 'dataurl',
        '.png': 'file',
        '.jpg': 'file',
        '.jpeg': 'file',
        '.gif': 'file'
      },
      plugins: [IgnoreCssPlugin],
      banner: {
        js: `
          import { Buffer as BufferPolyfill } from "buffer";
          if (typeof globalThis !== "undefined") {
            if (!globalThis.Buffer) globalThis.Buffer = BufferPolyfill;
            if (!globalThis.process) globalThis.process = { env: { NODE_ENV: 'production' } };
            if (!globalThis.global)  globalThis.global  = globalThis;
          }
        `.trim()
      },
      logLevel: 'info',
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
