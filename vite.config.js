// vite.config.js
import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  base: "/static/",        // <-- this line
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    open: true
  }
});