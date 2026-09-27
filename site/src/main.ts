import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-serif/400.css";
import "@fontsource/ibm-plex-serif/500.css";
import "./site.css";

const page = location.pathname.replace(/index\.html$/, "");
for (const a of document.querySelectorAll<HTMLAnchorElement>(".site-nav a[href^='/']")) {
  if (a.getAttribute("href") === page) a.setAttribute("aria-current", "page");
}

for (const block of document.querySelectorAll<HTMLElement>("[data-copy]")) {
  const text = block.textContent?.trim() ?? "";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy";
  button.textContent = "Copy";
  button.addEventListener("click", () => {
    void navigator.clipboard.writeText(text).then(() => {
      button.textContent = "Copied";
      window.setTimeout(() => (button.textContent = "Copy"), 1400);
    });
  });
  block.append(button);
}

const index = document.querySelector(".doc-index");
if (index) {
  const links = new Map([...index.querySelectorAll<HTMLAnchorElement>("a[href^='#']")].map((a) => [a.hash.slice(1), a]));
  links.values().next().value?.setAttribute("aria-current", "true");
  const reading = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      for (const a of links.values()) a.removeAttribute("aria-current");
      links.get(entry.target.id)?.setAttribute("aria-current", "true");
    }
  }, { rootMargin: "-15% 0px -75% 0px" });
  for (const id of links.keys()) {
    const section = document.getElementById(id);
    if (section) reading.observe(section);
  }
}
