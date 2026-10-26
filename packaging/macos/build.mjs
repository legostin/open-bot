// Builds the macOS installers around one Owlbot.app: an AppleScript app with the staged hub inside (both Node builds,
// Apple silicon and Intel). osacompile, codesign, hdiutil, pkgbuild and productbuild ship with macOS.
//   npm run package:mac [-- --skip-build] [-- --skip-stage]
// Output (unsigned):
//   dist/desktop/owlbot-<version>.dmg   drag Owlbot.app to Applications; it sets itself up when it first opens
//   dist/desktop/owlbot-<version>.pkg   the same app into /Applications, set up by the postinstall (silent installs)
// In the app: Contents/Resources/app is the hub (packaging/desktop/stage.mjs), Contents/Resources/bin the scripts (the
// user's LaunchAgent, the hub runner, the uninstaller for package installs).

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT, VERSION, run, stage } from "../desktop/stage.mjs";
import { LOCALES, loadCatalogs } from "../desktop/locales.mjs";
import { MIN_MACOS, PKG_ID, distributionXml, installerPage, launcherScript } from "./generate.mjs";

const HERE = import.meta.dirname;
const OUT = join(ROOT, "dist", "desktop");
const BUILD = join(OUT, "build-mac");
const ICON = join(ROOT, "packaging", "assets", "owlbot.icns");

if (process.platform !== "darwin") throw new Error("package:mac runs on macOS: it needs osacompile, codesign, hdiutil, pkgbuild and productbuild");

/** An AppleScript app with our name, version and icon; it is signed once its payload is in. */
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
}

function copyScripts(from, to, mode) {
  mkdirSync(to, { recursive: true });
  for (const f of readdirSync(from)) {
    copyFileSync(join(from, f), join(to, f));
    chmodSync(join(to, f), f.endsWith(".sh") && f !== "env.sh" ? 0o755 : mode);
  }
}

/** A copy of the app into `dir`: a clone on APFS, so it takes no space. */
function copyApp(bundle, dir) {
  mkdirSync(dir, { recursive: true });
  run("cp", ["-cRp", bundle, dir]);
}

const { values } = parseArgs({ options: { "skip-build": { type: "boolean" }, "skip-stage": { type: "boolean" } } });
const app = values["skip-stage"] ? join(OUT, "stage-darwin", "app") : await stage({ target: "darwin", skipBuild: !!values["skip-build"] });
for (const arch of ["arm64", "x64"]) {
  if (!existsSync(join(app, "runtime", arch, "bin", "node"))) throw new Error(`no staged app with runtime/${arch} in ${app}`);
}
rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });
const catalogs = loadCatalogs();

// The app, signed ad hoc as a whole (Apple silicon runs no broken signature). No --deep: Node keeps its own Developer
// ID signature and notarization, which lets a quarantined copy (dragged from a downloaded image) run it.
const bundle = join(BUILD, "Owlbot.app");
applet(bundle, launcherScript(catalogs), "ai.owlbot.app");
const contents = join(bundle, "Contents", "Resources");
cpSync(app, join(contents, "app"), { recursive: true, verbatimSymlinks: true });
copyScripts(join(HERE, "bin"), join(contents, "bin"), 0o644);
run("codesign", ["--force", "--sign", "-", bundle]);
run("codesign", ["--verify", "--strict", bundle]);

// Disk image: the app and a link to /Applications to drag it onto. hdiutil is sometimes busy on CI runners.
const image = join(BUILD, "dmg");
copyApp(bundle, image);
symlinkSync("/Applications", join(image, "Applications"));
const dmg = join(OUT, `owlbot-${VERSION}.dmg`);
for (let attempt = 1; ; attempt++) {
  try {
    run("hdiutil", ["create", "-volname", "Owlbot", "-srcfolder", image, "-format", "ULMO", "-ov", dmg]);
    break;
  } catch (e) {
    if (attempt === 3) throw e;
    execFileSync("sleep", ["5"]);
  }
}

// Component package with the same app in /Applications. It stays where it is installed: a relocatable bundle would be
// "upgraded" wherever the user moved a copy of it.
const root = join(BUILD, "root");
copyApp(bundle, join(root, "Applications"));
const comp = join(BUILD, "component.plist");
run("pkgbuild", ["--analyze", "--root", root, comp]);
const bundles = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", comp], { encoding: "utf8" }));
for (const b of bundles) Object.assign(b, { BundleIsRelocatable: false, BundleIsVersionChecked: false, BundleHasStrictIdentifier: false, BundleOverwriteAction: "upgrade" });
writeFileSync(comp + ".json", JSON.stringify(bundles));
run("plutil", ["-convert", "xml1", "-o", comp, comp + ".json"]);
const scripts = join(BUILD, "scripts");
copyScripts(join(HERE, "scripts"), scripts, 0o755);
const componentPkg = "owlbot-app.pkg";
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
const pkg = join(OUT, `owlbot-${VERSION}.pkg`);
run("productbuild", ["--distribution", distribution, "--resources", resources, "--package-path", BUILD, pkg]);
console.log(`disk image: ${dmg}\npackage:    ${pkg}`);
