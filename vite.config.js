// vite.config.js
import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  // keep base so built HTML references /static/...
  base: "/static/",
  root: ".",

  build: {
    outDir: "dist",
    emptyOutDir: true,

    // put hashed assets into /assets/ (default is 'assets' but explicit is clearer)
    assetsDir: "assets",

    // emit a manifest.json mapping original names → hashed filenames (helpful for deterministic copy)
    manifest: true,

    // recommend explicit rollup input for multi-page builds (ensures both index.html and whitepaper.html are built)
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        whitepaper: resolve(__dirname, "whitepaper.html"),
      },
      output: {
        // keep asset file names readable and grouped under assets/
        // the default hashing is preserved, but this ensures structure
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/chunk-[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },

    // optional: increase chunk warning limit if you get warnings for big deps like @solana/web3.js
    chunkSizeWarningLimit: 2000,
  },

  server: {
    port: 5173,
    open: true,
  },

  // convenient alias if you want to import from "@/..." in your code
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
