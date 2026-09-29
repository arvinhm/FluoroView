import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// `npm run dev` expects an engine on 127.0.0.1:7071 started with FLUOROVIEW_TOKEN=dev (7070 is the
// port of an installed FluoroView):
//   FLUOROVIEW_TOKEN=dev fluoroview --port 7071 --no-browser
// then open http://localhost:5173/#token=dev
//
// `npm run build:web` builds the browser version for fluoroview.com/studio, where the engine runs in
// the browser on the user's computer (src/local), into the site's public folder.
const engine = "http://127.0.0.1:7071";

export default defineConfig(({ mode }) => {
  const web = mode === "web";
  return {
    plugins: [react()],
    base: web ? "/studio/" : "/",
    define: { __LOCAL__: JSON.stringify(web) },
    build: {
      outDir: web ? "../site/public/studio" : "../engine/src/fluoroview/_studio",
      emptyOutDir: true,
      target: "es2022",
      sourcemap: !web,
    },
    worker: { format: "es" as const },
    server: {
      proxy: {
        "/api": { target: engine, changeOrigin: true, ws: true },
      },
      // the colour maps are read from the engine package (lib/lut.ts)
      fs: { allow: [".", "../engine/src/fluoroview"] },
    },
    test: {
      environment: "node",
    },
  };
});
