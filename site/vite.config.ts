import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** `<!-- @header -->` in a page is replaced by partials/header.html, so shared markup is written once. */
function partials(): Plugin {
  return {
    name: "partials",
    transformIndexHtml: (html) =>
      html.replace(/<!-- @(\w+) -->/g, (_, name: string) => readFileSync(here(`partials/${name}.html`), "utf8")),
  };
}

export default defineConfig({
  plugins: [partials()],
  build: {
    rollupOptions: {
      input: {
        home: here("index.html"),
        install: here("install/index.html"),
        docs: here("docs/index.html"),
        missing: here("404.html"),
      },
    },
  },
});
