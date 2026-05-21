import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  // base: "./" makes all asset paths relative (./assets/...) instead of absolute (/assets/...).
  // This lets the app work on ANY subdirectory – including GitHub Pages
  // (which serves at yoursite.github.io/REPO-NAME/) without needing config changes.
  // If you ever deploy to a root domain, this still works fine.
  base: "./",

  build: {
    outDir: "dist",
    assetsDir: "assets",
    // Generate source maps to help debug production issues
    sourcemap: false,
  },

  server: {
    // Allow access from local network (useful for testing on your phone over Wi-Fi)
    host: true,
    port: 5173,
  },
});
