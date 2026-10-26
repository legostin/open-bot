// Renders the web UI's favicon into the installers' icons: packaging/assets/open-bot.ico (Windows, PNG entries) and
// open-bot.icns (macOS). Run by hand when the logo changes; the outputs are committed so builds need no browser.
//   node packaging/desktop/make-icons.mjs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "..", "..");
const svg = readFileSync(join(ROOT, "packages", "web", "public", "favicon.svg"), "utf8");
const out = join(ROOT, "packaging", "assets");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
const png = {};
for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  png[size] = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
await browser.close();

// ICO: header, one directory entry per size, then the PNG images.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const header = Buffer.alloc(6 + 16 * icoSizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(icoSizes.length, 4);
let offset = header.length;
icoSizes.forEach((s, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(s >= 256 ? 0 : s, e);
  header.writeUInt8(s >= 256 ? 0 : s, e + 1);
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(png[s].length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += png[s].length;
});
writeFileSync(join(out, "open-bot.ico"), Buffer.concat([header, ...icoSizes.map((s) => png[s])]));

// ICNS: "icns" + length, then typed PNG chunks (16…512 and their @2x variants).
const icnsTypes = [["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024], ["ic11", 32], ["ic12", 64], ["ic13", 256], ["ic14", 512]];
const chunks = icnsTypes.map(([type, s]) => {
  const head = Buffer.alloc(8);
  head.write(type, 0, "ascii");
  head.writeUInt32BE(png[s].length + 8, 4);
  return Buffer.concat([head, png[s]]);
});
const icnsHead = Buffer.alloc(8);
icnsHead.write("icns", 0, "ascii");
icnsHead.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4);
writeFileSync(join(out, "open-bot.icns"), Buffer.concat([icnsHead, ...chunks]));
console.log(`icons written to ${out}`);
