// Renders the demo's made-up water shop (src/demo/assets/shop/shop.mjs) into the frames its browser chapter shows:
// src/demo/static/frames/<locale>/<page>.jpg, and map.json with where the parts the person points at are, in 0…1 of
// the picture. Run it after changing the shop: `node packages/web/scripts/render-shop.mjs`.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { PAGES, render } from "../src/demo/assets/shop/shop.mjs";

const OUT = resolve(import.meta.dirname, "../src/demo/static/frames");
const W = 1280;
const H = 800;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  for (const locale of ["en", "ru"]) {
    const dir = join(OUT, locale);
    mkdirSync(dir, { recursive: true });
    const map = {};
    for (const name of PAGES) {
      await page.setContent(render(locale, name), { waitUntil: "load" });
      await page.screenshot({ path: join(dir, `${name}.jpg`), type: "jpeg", quality: 78 });
      map[name] = await page.$$eval(
        "[data-demo]",
        (els, size) =>
          Object.fromEntries(
            els.map((el) => {
              const r = el.getBoundingClientRect();
              return [el.getAttribute("data-demo"), { x: r.x / size.w, y: r.y / size.h, w: r.width / size.w, h: r.height / size.h }];
            }),
          ),
        { w: W, h: H },
      );
    }
    writeFileSync(join(dir, "map.json"), JSON.stringify({ width: W, height: H, pages: map }, null, 2) + "\n");
    console.log(`frames/${locale}: ${PAGES.length} pages`);
  }
} finally {
  await browser.close();
}
