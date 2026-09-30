import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// The renderer is loaded from file:// inside Electron, hence relative asset paths.
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(import.meta.dirname, "dist/renderer"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        overlay: resolve(import.meta.dirname, "src/renderer/overlay.html"),
        history: resolve(import.meta.dirname, "src/renderer/history.html"),
      },
    },
  },
});
