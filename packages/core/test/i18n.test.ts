import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogProblems, readPluginLayout } from "@openbot/shared";
import { coreCatalog, LocalizedError, requestLocale, tFor } from "../src/i18n.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const pluginDirs = readdirSync(join(ROOT, "plugins"), { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(ROOT, "plugins", e.name, ".openbot-plugin", "plugin.json")))
  .map((e) => join(ROOT, "plugins", e.name));

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

  for (const dir of pluginDirs) {
    const id = dir.split(/[\\/]/).pop()!;
    it(`plugin ${id}: translations match English and cover the manifest`, () => {
      const layout = readPluginLayout(dir);
      if (!Object.keys(layout.messages).length) return;
      expect(catalogProblems(layout.messages)).toEqual([]);
      const raw = JSON.parse(readFileSync(join(dir, ".openbot-plugin", "plugin.json"), "utf8"));
      const missing = [...manifestRefs(raw)].filter((k) => !(k in (layout.messages.en ?? {})));
      expect(missing).toEqual([]);
    });
  }

  it("localizes errors per reader", () => {
    const e = new LocalizedError("task.notFound");
    expect(e.message).toBe("Task not found");
    expect(e.localized("ru")).toBe("Задача не найдена");
    expect(tFor("ru")("cli.auditOk", { count: 5 })).toBe("Журнал цел: 5 записей");
    expect(requestLocale({ headers: { "x-openbot-locale": "ru" } } as any)).toBe("ru");
    expect(requestLocale({ headers: { "accept-language": "ru-RU,ru;q=0.9" } } as any)).toBe("ru");
  });
});
