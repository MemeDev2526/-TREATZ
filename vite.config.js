// vite.config.js
import { defineConfig } from "vite";

export default defineConfig({
  root: ".",               // index.html at project root
  build: {
    outDir: "dist",        // build goes into ./dist
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    open: true,
  },
});