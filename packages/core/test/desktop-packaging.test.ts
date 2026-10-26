// The desktop installers' shared launcher and stage (packaging/desktop) and the text the macOS build generates
// (packaging/macos).
import { describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore: plain ESM helpers without type declarations
import { RESOLVE_HOOK, defaultDataDir, desktopPorts, hubEnv, openUrl, setupCode } from "../../../packaging/desktop/launch.mjs";
// @ts-ignore
import { resolveWorkspace, workspaces } from "../../../packaging/desktop/resolve.mjs";
// @ts-ignore
import { removeDanglingLinks, wanted } from "../../../packaging/desktop/stage.mjs";
// @ts-ignore
import { loadCatalogs } from "../../../packaging/desktop/locales.mjs";
// @ts-ignore
import { distributionXml, installerPage } from "../../../packaging/macos/generate.mjs";
// @ts-ignore
import { nsisHooks, nsisString } from "../../../packaging/windows/generate.mjs";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const tmp = () => mkdtempSync(join(tmpdir(), "owl-desktop-"));

describe("desktop launcher", () => {
  it("stages the hub without the desktop app's own sources", () => {
    expect(wanted(join(ROOT, "packages", "core", "src", "cli.ts"))).toBe(true);
    expect(wanted(join(ROOT, "packages", "desktop", "package.json"))).toBe(true);
    expect(wanted(join(ROOT, "packages", "desktop", "src-tauri", "target", "release", "owlbot"))).toBe(false);
    expect(wanted(join(ROOT, "packages", "desktop", "ui", "src", "main.ts"))).toBe(false);
    expect(wanted(join(ROOT, "packages", "core", "test", "hub.test.ts"))).toBe(false);
  });

  it("keeps data in the user's profile", () => {
    expect(defaultDataDir({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32", "C:\\Users\\u")).toBe(join("C:\\Users\\u\\AppData\\Local", "Owlbot"));
    expect(defaultDataDir({}, "darwin", "/Users/u")).toBe(join("/Users/u", "Library", "Application Support", "Owlbot"));
  });

  it("reads ports from desktop.json and keeps one setup code", () => {
    const data = tmp();
    expect(desktopPorts(data)).toEqual({ port: 41780, consolePort: 41781, egressPort: 41789 });
    writeFileSync(join(data, "desktop.json"), JSON.stringify({ port: 18080 }));
    expect(desktopPorts(data)).toEqual({ port: 18080, consolePort: 18081, egressPort: 18089 });
    const code = setupCode(data);
    expect(code).toMatch(/^[\w-]{12,64}$/);
    expect(setupCode(data)).toBe(code);
  });

  it("gives the hub its settings without overriding the caller's, and loads the resolve hook once", () => {
    const data = tmp();
    const env = hubEnv({ OWLBOT_PORT: "9999", NODE_OPTIONS: "--max-old-space-size=512" }, data);
    expect(env.OWLBOT_PORT).toBe("9999");
    expect(env.OWLBOT_DATA_DIR).toBe(data);
    expect(env.OWLBOT_PUBLIC_URL).toBe("http://localhost:41780");
    expect(env.OWLBOT_INSTALL_CLIS).toBe("1");
    expect(env.OWLBOT_DESKTOP).toBe("1");
    expect(env.OWLBOT_SETUP_TOKEN).toBe(readFileSync(join(data, "setup-code"), "utf8").trim());
    expect(env.NODE_OPTIONS).toBe(`--max-old-space-size=512 --import=${RESOLVE_HOOK}`);
    expect(hubEnv(env, data).NODE_OPTIONS).toBe(env.NODE_OPTIONS);
  });

  it("opens the setup form with the code until a password is set", async () => {
    const data = tmp();
    const code = setupCode(data);
    const answer = (hasPassword: boolean) => async () => new Response(JSON.stringify({ hasPassword }));
    expect(await openUrl(data, { fetchImpl: answer(false) })).toEqual({ ready: true, url: `http://localhost:41780/#setup=${code}` });
    expect(await openUrl(data, { fetchImpl: answer(true) })).toEqual({ ready: true, url: "http://localhost:41780/" });
    const down = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await openUrl(data, { fetchImpl: down, timeoutMs: 600 })).toEqual({ ready: false, url: "http://localhost:41780/" });
  });

  it("resolves @owlbot/* to the workspace folders without node_modules links", () => {
    const table = workspaces(ROOT);
    const shared = resolveWorkspace("@owlbot/shared", table);
    expect(shared && fileURLToPath(shared)).toBe(join(ROOT, "packages", "shared", table.get("@owlbot/shared").exports["."] ?? table.get("@owlbot/shared").exports));
    expect(resolveWorkspace("@owlbot/no-such-package", table)).toBeUndefined();
    expect(resolveWorkspace("react", table)).toBeUndefined();
  });

  // Windows creates links only with developer mode on.
  it.skipIf(process.platform === "win32")("drops links whose target is gone, keeps the others", () => {
    const app = tmp();
    mkdirSync(join(app, "runtime", "bin"), { recursive: true });
    writeFileSync(join(app, "runtime", "npm-cli.js"), "");
    symlinkSync("../npm-cli.js", join(app, "runtime", "bin", "npm"));
    symlinkSync("../lib/node_modules/corepack/dist/corepack.js", join(app, "runtime", "bin", "corepack"));
    expect(removeDanglingLinks(app)).toBe(1);
    expect(lstatSync(join(app, "runtime", "bin", "npm")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(app, "runtime", "bin", "corepack"))).toBe(false);
  });
});

describe("installer text", () => {
  const catalogs = loadCatalogs();

  it("writes NSIS strings", () => {
    expect(nsisString('Say "hi"\nfor $5')).toBe('"Say $\\"hi$\\"$\\nfor $$5"');
  });

  it("builds the NSIS hooks: the data question in both languages, a start after a silent install", () => {
    const hooks: string = nsisHooks(catalogs);
    expect(hooks).toContain("!macro NSIS_HOOK_POSTUNINSTALL");
    expect(hooks).toContain("${If} $LANGUAGE == 1049");
    expect(hooks).toContain("$LOCALAPPDATA\\Owlbot");
    expect(hooks).toContain("Удалить и ваши данные Owlbot");
    expect(hooks).toContain('Exec \'"$INSTDIR\\Owlbot.exe" --background\'');
    expect(hooks).not.toContain("{dir}");
  });

  it("builds the Installer pages and distribution", () => {
    const page = installerPage(catalogs, "ru", "welcome");
    expect(page).toContain('<html lang="ru">');
    expect(page).toContain("<h1>Добро пожаловать в Owlbot</h1>");
    const xml = distributionXml({ version: "1.2.3", componentPkg: "owlbot-app.pkg" });
    expect(xml).toContain('<pkg-ref id="ai.owlbot.pkg" version="1.2.3" onConclusion="none">owlbot-app.pkg</pkg-ref>');
    expect(xml).toContain('hostArchitectures="arm64,x86_64"');
  });
});
