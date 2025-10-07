// scripts/build-app.js
import { build } from 'esbuild';
import { nodeExternalsPlugin } from 'esbuild-node-externals';
import path from 'path';

// Simple build: bundle `app.js` → static/app.js
const entry = path.resolve('app.js');   // your uploaded runtime
const out = path.resolve('static/app.js');

await build({
  entryPoints: [entry],
  bundle: true,
  minify: true,
  platform: 'browser',
  target: ['es2020'],
  outfile: out,
  sourcemap: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
  },
  loader: {
    '.js': 'js',
    '.svg': 'text', // if you import svg assets inline
  },
  logLevel: 'info'
});
console.log('[TREATZ] esbuild: bundled app.js -> static/app.js');
