// vite.config.js
import { defineConfig } from "vite";

export default defineConfig({
  root: ".", // use project root (index.html lives here)
  build: {
    outDir: "static",     // 👈 build directly into the static/ folder
    emptyOutDir: true,    // clear old builds before each build
  },
  server: {
    port: 5173,
    open: true
  }
});