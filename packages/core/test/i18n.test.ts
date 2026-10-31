import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogProblems, createRpcPeer, memoryTransportPair, readPluginLayout } from "@piomio/shared";
import { configureHubLocale, coreCatalog, LocalizedError, requestLocale, tFor } from "../src/i18n.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
// Built-in plugins and integrations, the integration template included.
const pluginDirs = ["plugins", "integrations"].flatMap((group) =>
  readdirSync(join(ROOT, group), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(ROOT, group, e.name, ".piomio-plugin", "plugin.json")))
    .map((e) => join(ROOT, group, e.name)),
);

/** "%key%" references anywhere in a manifest. */
function manifestRefs(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === "string") {
    const m = /^%([\w.-]+)%$/.exec(v);
    if (m) out.add(m[1]);
  } else if (Array.isArray(v)) v.forEach((x) => manifestRefs(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => manifestRefs(x, out));
  return out;
}

describe("i18n catalogs", () => {
  it("core translations match English", () => {
    expect(catalogProblems(coreCatalog)).toEqual([]);
  });

  it("installer translations match English", async () => {
    // @ts-ignore: plain ESM helper without type declarations
    const { loadCatalogs } = await import("../../../packaging/desktop/locales.mjs");
    expect(catalogProblems(loadCatalogs())).toEqual([]);
  });

  for (const dir of pluginDirs) {
    const id = dir.split(/[\\/]/).pop()!;
    it(`plugin ${id}: translations match English and cover the manifest`, () => {
      const layout = readPluginLayout(dir);
      if (!Object.keys(layout.messages).length) return;
      expect(catalogProblems(layout.messages)).toEqual([]);
      const raw = JSON.parse(readFileSync(join(dir, ".piomio-plugin", "plugin.json"), "utf8"));
      const missing = [...manifestRefs(raw)].filter((k) => !(k in (layout.messages.en ?? {})));
      expect(missing).toEqual([]);
    });
  }

  it("localizes errors per reader", () => {
    const e = new LocalizedError("task.notFound");
    expect(e.message).toBe("Task not found");
    expect(e.localized("ru")).toBe("Задача не найдена");
    expect(tFor("ru")("cli.auditOk", { count: 5 })).toBe("Журнал цел: 5 записей");
    expect(requestLocale({ headers: { "x-piomio-locale": "ru" } } as any)).toBe("ru");
    expect(requestLocale({ headers: { "accept-language": "ru-RU,ru;q=0.9" } } as any)).toBe("ru");
  });

  it("sends the key and the hub-language text with errors over RPC", async () => {
    configureHubLocale(() => "ru");
    try {
      const [a, b] = memoryTransportPair();
      const hub = createRpcPeer(a);
      const plugin = createRpcPeer(b);
      hub.handle("vault.get", () => {
        throw new LocalizedError("vault.notFound", { id: "x" });
      });
      const err: any = await plugin.request("vault.get", {}).catch((e) => e);
      expect(err.message).toBe("No vault item vault://x");
      expect(err.data).toEqual({ key: "vault.notFound", params: { id: "x" }, text: "Нет записи vault://x" });
    } finally {
      configureHubLocale(() => "en");
    }
  });
});
