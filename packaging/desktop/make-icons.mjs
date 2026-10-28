// Renders the 0_0 mark into the desktop icons. Run by hand when the logo changes; the outputs are committed so builds
// need no browser:
//   packages/web/public/favicon.svg (the mark)  -> packaging/assets/owlbot.ico (Windows, PNG entries), png/ (Tauri)
//   packaging/assets/app-icon.svg (Apple grid)  -> packaging/assets/owlbot.icns (macOS)
//   packaging/assets/tray.svg (the glyph)       -> packaging/assets/png/tray.png (the macOS menu bar, a template image)
//   packaging/assets/dmg-background.svg         -> packaging/assets/dmg-background.tiff (1x and Retina, macOS tiffutil)
//   node packaging/desktop/make-icons.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "..", "..");
const out = join(ROOT, "packaging", "assets");
mkdirSync(out, { recursive: true });
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

const browser = await chromium.launch();
const page = await browser.newPage();
/** `{ size: PNG }` of an SVG file, on a transparent background; `height` for one that is not square. */
async function render(file, list, height = (size) => size) {
  const svg = readFileSync(file, "utf8");
  const shots = {};
  for (const size of list) {
    const h = height(size);
    await page.setViewportSize({ width: size, height: h });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${h}" `)}</body></html>`);
    shots[size] = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: h } });
  }
  return shots;
}
const png = await render(join(ROOT, "packages", "web", "public", "favicon.svg"), sizes);
const appIcon = await render(join(out, "app-icon.svg"), sizes);
const tray = await render(join(out, "tray.svg"), [44]);
const dmg = await render(join(out, "dmg-background.svg"), [660, 1320], (w) => (w * 400) / 660);
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
writeFileSync(join(out, "owlbot.ico"), Buffer.concat([header, ...icoSizes.map((s) => png[s])]));

// ICNS: "icns" + length, then typed PNG chunks (16…512 and their @2x variants).
const icnsTypes = [["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024], ["ic11", 32], ["ic12", 64], ["ic13", 256], ["ic14", 512]];
const chunks = icnsTypes.map(([type, s]) => {
  const head = Buffer.alloc(8);
  head.write(type, 0, "ascii");
  head.writeUInt32BE(appIcon[s].length + 8, 4);
  return Buffer.concat([head, appIcon[s]]);
});
const icnsHead = Buffer.alloc(8);
icnsHead.write("icns", 0, "ascii");
icnsHead.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4);
writeFileSync(join(out, "owlbot.icns"), Buffer.concat([icnsHead, ...chunks]));
// PNGs for the Tauri bundle (tauri.conf.json "bundle.icon"; the tray uses the app icon).
mkdirSync(join(out, "png"), { recursive: true });
for (const [file, size] of [["32x32.png", 32], ["128x128.png", 128], ["128x128@2x.png", 256], ["icon.png", 512]]) writeFileSync(join(out, "png", file), png[size]);
writeFileSync(join(out, "png", "tray.png"), tray[44]);
// The .dmg window's background: Finder picks the Retina image from a two-image TIFF.
const tmp = mkdtempSync(join(tmpdir(), "owlbot-dmg-"));
writeFileSync(join(tmp, "bg.png"), dmg[660]);
writeFileSync(join(tmp, "bg@2x.png"), dmg[1320]);
execFileSync("tiffutil", ["-cathidpicheck", join(tmp, "bg.png"), join(tmp, "bg@2x.png"), "-out", join(out, "dmg-background.tiff")]);
rmSync(tmp, { recursive: true });
console.log(`icons written to ${out}`);
