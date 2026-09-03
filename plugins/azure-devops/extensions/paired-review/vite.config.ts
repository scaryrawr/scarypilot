import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/app/",
  plugins: [react()],
  publicDir: false,
  build: {
    emptyOutDir: true,
    outDir: "public",
    rollupOptions: {
      output: {
        assetFileNames: "assets/[name][extname]",
        entryFileNames: "assets/app.js",
        inlineDynamicImports: true,
      },
    },
  },
});
