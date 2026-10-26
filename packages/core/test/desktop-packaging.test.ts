// The desktop installers' shared launcher (packaging/desktop) and the text the macOS build generates (packaging/macos).
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore: plain ESM helpers without type declarations
import { RESOLVE_HOOK, defaultDataDir, desktopPorts, hubEnv, openUrl, setupCode } from "../../../packaging/desktop/launch.mjs";
// @ts-ignore
import { resolveWorkspace, workspaces } from "../../../packaging/desktop/resolve.mjs";
// @ts-ignore
import { loadCatalogs } from "../../../packaging/desktop/locales.mjs";
// @ts-ignore
import { appleScriptText, distributionXml, installerPage, launcherScript, uninstallerScript } from "../../../packaging/macos/generate.mjs";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const tmp = () => mkdtempSync(join(tmpdir(), "ob-desktop-"));

describe("desktop launcher", () => {
  it("keeps data in the user's profile", () => {
    expect(defaultDataDir({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32", "C:\\Users\\u")).toBe(join("C:\\Users\\u\\AppData\\Local", "open-bot"));
    expect(defaultDataDir({}, "darwin", "/Users/u")).toBe(join("/Users/u", "Library", "Application Support", "open-bot"));
  });

  it("reads ports from desktop.json and keeps one setup code", () => {
    const data = tmp();
    expect(desktopPorts(data)).toEqual({ port: 8080, consolePort: 8081, egressPort: 8089 });
    writeFileSync(join(data, "desktop.json"), JSON.stringify({ port: 18080 }));
    expect(desktopPorts(data)).toEqual({ port: 18080, consolePort: 18081, egressPort: 18089 });
    const code = setupCode(data);
    expect(code).toMatch(/^[\w-]{12,64}$/);
    expect(setupCode(data)).toBe(code);
  });

  it("gives the hub its settings without overriding the caller's, and loads the resolve hook once", () => {
    const data = tmp();
    const env = hubEnv({ OPENBOT_PORT: "9999", NODE_OPTIONS: "--max-old-space-size=512" }, data);
    expect(env.OPENBOT_PORT).toBe("9999");
    expect(env.OPENBOT_DATA_DIR).toBe(data);
    expect(env.OPENBOT_PUBLIC_URL).toBe("http://localhost:8080");
    expect(env.OPENBOT_INSTALL_CLIS).toBe("1");
    expect(env.OPENBOT_SETUP_TOKEN).toBe(readFileSync(join(data, "setup-code"), "utf8").trim());
    expect(env.NODE_OPTIONS).toBe(`--max-old-space-size=512 --import=${RESOLVE_HOOK}`);
    expect(hubEnv(env, data).NODE_OPTIONS).toBe(env.NODE_OPTIONS);
  });

  it("opens the setup form with the code until a password is set", async () => {
    const data = tmp();
    const code = setupCode(data);
    const answer = (hasPassword: boolean) => async () => new Response(JSON.stringify({ hasPassword }));
    expect(await openUrl(data, { fetchImpl: answer(false) })).toEqual({ ready: true, url: `http://localhost:8080/#setup=${code}` });
    expect(await openUrl(data, { fetchImpl: answer(true) })).toEqual({ ready: true, url: "http://localhost:8080/" });
    const down = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await openUrl(data, { fetchImpl: down, timeoutMs: 600 })).toEqual({ ready: false, url: "http://localhost:8080/" });
  });

  it("resolves @openbot/* to the workspace folders without node_modules links", () => {
    const table = workspaces(ROOT);
    const shared = resolveWorkspace("@openbot/shared", table);
    expect(shared && fileURLToPath(shared)).toBe(join(ROOT, "packages", "shared", table.get("@openbot/shared").exports["."] ?? table.get("@openbot/shared").exports));
    expect(resolveWorkspace("@openbot/no-such-package", table)).toBeUndefined();
    expect(resolveWorkspace("react", table)).toBeUndefined();
  });
});

describe("macOS installer text", () => {
  const catalogs = loadCatalogs();

  it("writes AppleScript strings in ASCII", () => {
    expect(appleScriptText('Say "hi"\\now')).toBe('"Say \\"hi\\"\\\\now"');
    expect(appleScriptText("Log: {file}.\nOK")).toBe('"Log: " & p_file & "." & linefeed & "OK"');
    expect(appleScriptText("Да")).toBe("(character id {1044, 1072})");
    expect(appleScriptText("")).toBe('""');
  });

  for (const [name, script] of [
    ["open-bot.app", () => launcherScript(catalogs)],
    ["Uninstall open-bot.app", () => uninstallerScript(catalogs)],
  ] as const) {
    it(`${name}: ASCII source, and every message it shows is defined`, () => {
      const src: string = script();
      expect(/^[\x09\x0a\x20-\x7e]*$/.test(src)).toBe(true);
      const called = new Set([...src.matchAll(/my (T_\w+)\(/g)].map((m) => m[1]));
      const defined = new Set([...src.matchAll(/^on (T_\w+)\(/gm)].map((m) => m[1]));
      expect(called.size).toBeGreaterThan(1);
      expect([...called].filter((h) => !defined.has(h))).toEqual([]);
    });
  }

  it("builds the Installer pages and distribution", () => {
    const page = installerPage(catalogs, "ru", "welcome");
    expect(page).toContain('<html lang="ru">');
    expect(page).toContain("<h1>Добро пожаловать в open-bot</h1>");
    const xml = distributionXml({ version: "1.2.3", componentPkg: "open-bot-app.pkg" });
    expect(xml).toContain('<pkg-ref id="ai.openbot.pkg" version="1.2.3" onConclusion="none">open-bot-app.pkg</pkg-ref>');
    expect(xml).toContain('hostArchitectures="arm64,x86_64"');
  });
});
