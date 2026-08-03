import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/postcss";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const docsRoot = fileURLToPath(new URL("../docs/", import.meta.url));
const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const siteModules = fileURLToPath(new URL("./node_modules/", import.meta.url));

export default defineConfig({
  root: docsRoot,
  base: "/",
  plugins: [react()],
  css: {
    postcss: {
      plugins: [tailwindcss()],
    },
  },
  resolve: {
    alias: [
      { find: "enqiu", replacement: fileURLToPath(new URL("../src/index.ts", import.meta.url)) },
      { find: /^react$/, replacement: `${siteModules}react/index.js` },
      { find: /^react\/jsx-runtime$/, replacement: `${siteModules}react/jsx-runtime.js` },
      { find: /^react-dom\/client$/, replacement: `${siteModules}react-dom/client.js` },
      { find: /^motion\/react$/, replacement: `${siteModules}motion/dist/es/react.mjs` },
    ],
  },
  build: {
    outDir: fileURLToPath(new URL("./public/", import.meta.url)),
    emptyOutDir: false,
    rollupOptions: {
      output: {
        entryFileNames: "landing.js",
        chunkFileNames: "landing-[name].js",
        assetFileNames: "landing.[ext]",
      },
    },
  },
  server: {
    fs: {
      allow: [docsRoot, sourceRoot, siteModules],
    },
  },
});
