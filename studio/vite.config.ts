import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// `npm run dev` expects an engine on 127.0.0.1:7070 started with FLUOROVIEW_TOKEN=dev:
//   FLUOROVIEW_TOKEN=dev fluoroview --port 7070 --no-browser
// then open http://localhost:5173/#token=dev
const engine = "http://127.0.0.1:7070";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../engine/src/fluoroview/_studio",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
  },
  server: {
    proxy: {
      "/api": { target: engine, changeOrigin: true, ws: true },
    },
  },
  test: {
    environment: "node",
  },
});
