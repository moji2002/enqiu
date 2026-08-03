import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const siteRoot = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL("./admin/", import.meta.url)),
  base: "/admin/",
  plugins: [react()],
  resolve: {
    alias: {
      enqiu: fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./public/admin/", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "admin.js",
        chunkFileNames: "[name].js",
        assetFileNames: "admin.[ext]",
      },
    },
  },
  server: {
    fs: {
      allow: [siteRoot, fileURLToPath(new URL("../src/", import.meta.url))],
    },
  },
});
