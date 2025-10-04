// vite.config.js
import { defineConfig } from "vite";

export default defineConfig({
  root: ".", // use project root (since index.html is here)
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    open: true
  }
});