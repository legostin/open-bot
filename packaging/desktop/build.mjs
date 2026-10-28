// Builds the Owlbot desktop app (packages/desktop, Tauri) and its installers on this OS:
//   npm run package:desktop [-- --skip-build] [-- --skip-stage] [-- --test]
// macOS:   dist/desktop/owlbot-<version>.dmg (drag to Applications) and owlbot-<version>.pkg (silent installs).
//          Universal: needs the aarch64-apple-darwin and x86_64-apple-darwin Rust targets.
// Windows: dist/desktop/owlbot-setup-<version>-x64.exe (NSIS, per user; /S silent, /NOSTART).
// --test builds "Owlbot Test" (ai.owlbot.test, owlbot-test://) instead: it installs next to the app with its own data,
// node pairing, start-at-login entry and ports (41790...), and says so in its windows and tray. Disk image or Windows
// installer only (owlbot-test-<version>.dmg, owlbot-test-setup-<version>-x64.exe), no .pkg.
// The staged hub (stage.mjs) is the app's resource "app".

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT, VERSION, npm, stage } from "./stage.mjs";
import { loadCatalogs } from "./locales.mjs";
import { buildPkg } from "../macos/pkg.mjs";
import { nsisHooks } from "../windows/generate.mjs";

const mac = process.platform === "darwin";
if (!mac && process.platform !== "win32") throw new Error("package:desktop runs on macOS or Windows");
const OUT = join(ROOT, "dist", "desktop");
const TAURI = join(ROOT, "packages", "desktop", "src-tauri");
const target = mac ? "darwin" : "win-x64";

const { values } = parseArgs({ options: { "skip-build": { type: "boolean" }, "skip-stage": { type: "boolean" }, test: { type: "boolean" } } });
const test = !!values.test;
const product = test ? "Owlbot Test" : "Owlbot";
const file = test ? "owlbot-test" : "owlbot";
const app = values["skip-stage"] ? join(OUT, `stage-${target}`, "app") : await stage({ target, skipBuild: !!values["skip-build"] });
if (!existsSync(join(app, "packaging", "desktop", "launch.mjs"))) throw new Error(`no staged app in ${app}`);
npm(["run", "build:ui", "-w", "@owlbot/desktop"], { cwd: ROOT });

const build = join(OUT, mac ? "build-mac" : "build-win");
rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });
// A mapped folder keeps its layout under the target (tauri-utils walks it).
const resources = { [app]: "app" };
const config = { bundle: { resources } };
if (test) {
  Object.assign(config, { productName: product, mainBinaryName: product, identifier: "ai.owlbot.test", plugins: { "deep-link": { desktop: { schemes: ["owlbot-test"] } } } });
}
if (mac) {
  // For package installs; the test build has none.
  if (!test) resources[join(ROOT, "packaging", "macos", "uninstall.sh")] = "uninstall.sh";
} else {
  const hooks = join(build, "nsis-hooks.nsh");
  writeFileSync(hooks, nsisHooks(loadCatalogs(), product));
  config.bundle.windows = { nsis: { installerHooks: hooks } };
}
const configFile = join(build, "tauri.build.json");
writeFileSync(configFile, JSON.stringify(config, null, 2));

const triple = mac ? "universal-apple-darwin" : undefined;
npm(["run", "tauri", "-w", "@owlbot/desktop", "--", "build", "--config", configFile, "--bundles", mac ? "app,dmg" : "nsis", ...(triple ? ["--target", triple] : [])], { cwd: ROOT });

const bundle = join(TAURI, "target", ...(triple ? [triple] : []), "release", "bundle");
if (mac) {
  const dmg = join(OUT, `${file}-${VERSION}.dmg`);
  copyFileSync(join(bundle, "dmg", `${product}_${VERSION}_universal.dmg`), dmg);
  console.log(`disk image: ${dmg}`);
  if (!test) console.log(`package:    ${buildPkg({ appBundle: join(bundle, "macos", "Owlbot.app"), build, out: join(OUT, `owlbot-${VERSION}.pkg`) })}`);
} else {
  const setup = join(OUT, `${file}-setup-${VERSION}-x64.exe`);
  copyFileSync(join(bundle, "nsis", `${product}_${VERSION}_x64-setup.exe`), setup);
  console.log(`installer: ${setup}`);
}
