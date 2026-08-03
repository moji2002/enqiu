import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const docsRoot = fileURLToPath(new URL("../docs/", import.meta.url));
const siteModules = fileURLToPath(new URL("./node_modules/", import.meta.url));

export default defineConfig({
  root: docsRoot,
  base: "/",
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^react$/, replacement: `${siteModules}react/index.js` },
      { find: /^react\/jsx-runtime$/, replacement: `${siteModules}react/jsx-runtime.js` },
      { find: /^react-dom\/client$/, replacement: `${siteModules}react-dom/client.js` },
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
      allow: [docsRoot, siteModules],
    },
  },
});
