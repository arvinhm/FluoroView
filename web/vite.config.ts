import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Base is relative so the built bundle can be served from any static path
// (GitHub Pages project sites, release artifacts, etc.).
export default defineConfig({
  base: "./",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icons/apple-touch-icon.png"],
      manifest: {
        name: "FluoroView v3",
        short_name: "FluoroView",
        description: "GPU-accelerated web platform for multiplex fluorescence & H&E spatial biology.",
        theme_color: "#05070d",
        background_color: "#05070d",
        display: "standalone",
        start_url: "./",
        scope: "./",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        globIgnores: ["**/data/**"],
        maximumFileSizeToCacheInBytes: 3_000_000,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes("/data/"),
            handler: "CacheFirst",
            options: { cacheName: "fv-data", expiration: { maxEntries: 40 } },
          },
          {
            urlPattern: ({ url }) => url.origin.includes("fonts.g"),
            handler: "CacheFirst",
            options: { cacheName: "fv-fonts", expiration: { maxEntries: 20 } },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
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
  // The upload worker pulls in geotiff, so its bundle is code-split — which
  // rules out Vite's default `iife` worker format.
  worker: { format: "es" },
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 1400,
  },
});
