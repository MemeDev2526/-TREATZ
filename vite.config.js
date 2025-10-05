// vite.config.js
import { defineConfig } from "vite";

export default defineConfig({
  base: "/static/",      // <--- ensures built HTML references /static/assets/...
  root: ".",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    open: true,
  },
});