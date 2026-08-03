import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const siteRoot = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL("./playground/", import.meta.url)),
  base: "/playground/",
  plugins: [react()],
  resolve: {
    alias: {
      enqiu: fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./public/playground/", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "playground.js",
        chunkFileNames: "[name].js",
        assetFileNames: "playground.[ext]",
      },
    },
  },
  server: {
    fs: {
      allow: [siteRoot, fileURLToPath(new URL("../src/", import.meta.url))],
    },
  },
});
