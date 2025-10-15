// vite.config.js
import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  // All asset URLs and imports resolve under /static/
  base: "/static/",
  root: ".",

  // Speed up dev startup and avoid large ESM re-bundling
  optimizeDeps: {
    include: ["@solana/web3.js", "@solana/spl-token"],
  },

  build: {
    // ⚠️ Note: we no longer hardcode outDir = "dist"
    // because your npm script already passes --outDir static
    emptyOutDir: true,

    // Emit hashed assets into /assets/ (explicit is clearer)
    assetsDir: "assets",

    // Produce manifest.json for deterministic hashed filenames
    manifest: true,

    // Explicit Rollup entry points for multipage builds
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        whitepaper: resolve(__dirname, "whitepaper.html"),
      },
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/chunk-[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },

    // bundle all CSS into one (helps stable file naming)
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
      "@": resolve(__dirname, "src"),
    },
  },
});