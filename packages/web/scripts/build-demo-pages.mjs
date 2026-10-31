// The demo's agent-made page (demo-pages/walk/), built the way the hub serves a page: compiled by the hub's own page
// compiler, wrapped in the hub's own HTML with the pages kit, one copy per locale with that locale's data. The output
// goes to src/demo/static/pages/ (not kept in git), which the demo build serves next to demo.html:
//   pages/kit/…            the kit (packages/pages-kit/dist, build it first)
//   pages/walk-<locale>/   index.html, page.js and the page's pictures

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compilePage, loadKit, Pages } from "../../core/src/pages.ts";

const WEB = resolve(import.meta.dirname, "..");
const SRC = join(WEB, "demo-pages/walk");
const KIT = resolve(WEB, "../pages-kit/dist");
const OUT = join(WEB, "src/demo/static/pages");

const kit = loadKit(KIT);
if (!kit) {
  console.error("The pages kit is not built: npm run build -w @piomio/pages-kit");
  process.exit(1);
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(KIT, join(OUT, "kit"), { recursive: true });

const script = compilePage(readFileSync(join(SRC, "page.tsx"), "utf8"));
for (const locale of ["en", "ru"]) {
  const data = JSON.parse(readFileSync(join(SRC, `data.${locale}.json`), "utf8"));
  const dir = join(OUT, `walk-${locale}`);
  mkdirSync(dir, { recursive: true });
  const view = { id: "walk", title: data.title, agentId: "pio", url: "./", version: 1, createdAt: "", updatedAt: "" };
  // The hub's own template, with this page's data and no saved state.
  const html = Pages.prototype.html.call({ source: () => ({ data }), state: () => ({}) }, view, { base: "../kit/", theme: kit.theme }, locale);
  writeFileSync(join(dir, "index.html"), html);
  writeFileSync(join(dir, "page.js"), script);
  if (existsSync(join(SRC, "art"))) cpSync(join(SRC, "art"), join(dir, "art"), { recursive: true });
}
console.log("demo pages: walk-en, walk-ru");
