// vite.config.js
import { defineConfig } from "vite";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  // All asset URLs and imports resolve under /static/
  base: "/static/",
  root: ".",

  // Speed up dev startup and avoid large ESM re-bundling
  optimizeDeps: {
    include: ["@solana/web3.js", "@solana/spl-token"],
  },

  build: {
    // Write build straight to /static so the site can serve it directly
    outDir: "static",
    emptyOutDir: true,

    // Emit hashed assets into /assets/
    assetsDir: "assets",

    // Produce manifest.json for deterministic hashed filenames
    manifest: true,

    // Explicit Rollup entry points for multipage builds
    rollupOptions: {
      input: {
        main: resolve(__root, "index.html"),
        whitepaper: resolve(__root, "whitepaper.html"),
      },
      // IMPORTANT: don't try to bundle absolute /static/* references (e.g., /static/app.js)
      external: id => id.startsWith("/static/"),
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/chunk-[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },

    // Bundle all CSS into one (stable file naming)
    cssCodeSplit: false,

    // Raise warning limit for Solana deps
    chunkSizeWarningLimit: 2000,
  },

  server: {
    port: 5173,
    open: true,
  },

  resolve: {
    alias: {
      "@": resolve(__root, "src"),
    },
  },
});