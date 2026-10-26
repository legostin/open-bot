// Builds the macOS installer: stages the app with both Node builds (Apple silicon and Intel), compiles the two
// AppleScript apps and wraps it all into a product archive. pkgbuild, productbuild and osacompile ship with macOS.
//   npm run package:mac [-- --skip-build] [-- --skip-stage]
// Output: dist/desktop/open-bot-<version>.pkg (unsigned). It installs
//   /Applications/open-bot/open-bot.app             opens open-bot in the browser, starting the hub if needed
//   /Applications/open-bot/Uninstall open-bot.app
//   /Library/Application Support/open-bot/app       the hub (packaging/desktop/stage.mjs)
//   /Library/Application Support/open-bot/bin       scripts: the user's LaunchAgent, the hub runner, the uninstaller

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT, VERSION, run, stage } from "../desktop/stage.mjs";
import { LOCALES, loadCatalogs } from "../desktop/locales.mjs";
import { MIN_MACOS, PKG_ID, distributionXml, installerPage, launcherScript, uninstallerScript } from "./generate.mjs";

const HERE = import.meta.dirname;
const OUT = join(ROOT, "dist", "desktop");
const BUILD = join(OUT, "build-mac");
const ICON = join(ROOT, "packaging", "assets", "open-bot.icns");

if (process.platform !== "darwin") throw new Error("package:mac runs on macOS: it needs pkgbuild, productbuild and osacompile");

/** An AppleScript app with our name, version and icon, signed ad hoc again (Apple silicon runs no broken signature). */
function applet(bundle, source, id) {
  const src = join(BUILD, basename(bundle, ".app") + ".applescript");
  writeFileSync(src, source);
  run("osacompile", ["-o", bundle, src]);
  const plist = join(bundle, "Contents", "Info.plist");
  const set = (key, value) => run("plutil", ["-replace", key, "-string", value, plist]);
  set("CFBundleIdentifier", id);
  set("CFBundleName", basename(bundle, ".app"));
  set("CFBundleShortVersionString", VERSION);
  set("CFBundleVersion", VERSION);
  set("LSMinimumSystemVersion", MIN_MACOS);
  set("CFBundleIconFile", "applet");
  // Newer osacompile also puts the icon in an asset catalog, which would win over applet.icns.
  try {
    execFileSync("plutil", ["-remove", "CFBundleIconName", plist], { stdio: "ignore" });
  } catch {
    /* not there */
  }
  rmSync(join(bundle, "Contents", "Resources", "Assets.car"), { force: true });
  copyFileSync(ICON, join(bundle, "Contents", "Resources", "applet.icns"));
  run("codesign", ["--force", "--sign", "-", bundle]);
}

function copyScripts(from, to, mode) {
  mkdirSync(to, { recursive: true });
  for (const f of readdirSync(from)) {
    copyFileSync(join(from, f), join(to, f));
    chmodSync(join(to, f), f.endsWith(".sh") && f !== "env.sh" ? 0o755 : mode);
  }
}

const { values } = parseArgs({ options: { "skip-build": { type: "boolean" }, "skip-stage": { type: "boolean" } } });
const app = values["skip-stage"] ? join(OUT, "stage-darwin", "app") : await stage({ target: "darwin", skipBuild: !!values["skip-build"] });
for (const arch of ["arm64", "x64"]) {
  if (!existsSync(join(app, "runtime", arch, "bin", "node"))) throw new Error(`no staged app with runtime/${arch} in ${app}`);
}
rmSync(BUILD, { recursive: true, force: true });
const catalogs = loadCatalogs();

// Payload.
const root = join(BUILD, "root");
const support = join(root, "Library", "Application Support", "open-bot");
cpSync(app, join(support, "app"), { recursive: true, verbatimSymlinks: true });
copyScripts(join(HERE, "bin"), join(support, "bin"), 0o644);
const apps = join(root, "Applications", "open-bot");
mkdirSync(apps, { recursive: true });
applet(join(apps, "open-bot.app"), launcherScript(catalogs), "ai.openbot.app");
applet(join(apps, "Uninstall open-bot.app"), uninstallerScript(catalogs), "ai.openbot.uninstall");

// Component package. Its apps stay where they are installed: a relocatable bundle would be "upgraded" wherever the
// user moved a copy of it.
const comp = join(BUILD, "component.plist");
run("pkgbuild", ["--analyze", "--root", root, comp]);
const bundles = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", comp], { encoding: "utf8" }));
for (const b of bundles) Object.assign(b, { BundleIsRelocatable: false, BundleIsVersionChecked: false, BundleHasStrictIdentifier: false, BundleOverwriteAction: "upgrade" });
writeFileSync(comp + ".json", JSON.stringify(bundles));
run("plutil", ["-convert", "xml1", "-o", comp, comp + ".json"]);
const scripts = join(BUILD, "scripts");
copyScripts(join(HERE, "scripts"), scripts, 0o755);
const componentPkg = "open-bot-app.pkg";
run("pkgbuild", ["--root", root, "--install-location", "/", "--identifier", PKG_ID, "--version", VERSION, "--scripts", scripts, "--component-plist", comp, join(BUILD, componentPkg)]);

// Product archive with the English and Russian Installer pages.
const resources = join(BUILD, "resources");
for (const locale of LOCALES) {
  const dir = join(resources, `${locale}.lproj`);
  mkdirSync(dir, { recursive: true });
  for (const page of ["welcome", "conclusion"]) writeFileSync(join(dir, `${page}.html`), installerPage(catalogs, locale, page));
}
const distribution = join(BUILD, "distribution.xml");
writeFileSync(distribution, distributionXml({ version: VERSION, componentPkg }));
const out = join(OUT, `open-bot-${VERSION}.pkg`);
run("productbuild", ["--distribution", distribution, "--resources", resources, "--package-path", BUILD, out]);
console.log(`installer: ${out}`);
