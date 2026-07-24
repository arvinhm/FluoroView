import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Base is relative so the built bundle can be served from any static path
// (GitHub Pages project sites, release artifacts, etc.).
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    port: 5273,
    host: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8010",
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 1400,
  },
});
