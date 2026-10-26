/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogProblems, format, translator } from "@owlbot/shared/i18n";
import en from "./en";
import ru from "./ru";

const CYRILLIC = /\p{Script=Cyrillic}/u;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("web UI catalogs", () => {
  it("ru has exactly the en keys with the same placeholders", () => {
    expect(catalogProblems({ en, ru })).toEqual([]);
  });

  it("en has no Cyrillic text", () => {
    expect(Object.entries(en).filter(([, v]) => CYRILLIC.test(v))).toEqual([]);
  });

  it("Russian plurals have the few and many forms", () => {
    const plurals = Object.entries(ru).filter(([, v]) => v.includes(", plural,"));
    expect(plurals.length).toBeGreaterThan(0);
    for (const [key, v] of plurals) expect([key, /few \{/.test(v) && /many \{/.test(v)]).toEqual([key, true]);
  });

  it("formats placeholders and plurals per locale", () => {
    const tEn = translator({ en, ru }, "en");
    const tRu = translator({ en, ru }, "ru");
    expect(tEn("mcp.tools", { n: 1 })).toBe("1 tool");
    expect(tEn("mcp.tools", { n: 5 })).toBe("5 tools");
    expect(tEn("tasks.resumes", { time: "in 5 minutes" })).toBe("resumes in 5 minutes");
    expect(tRu("mcp.tools", { n: 1 })).toBe(format(ru["mcp.tools"], { n: 1 }, "ru"));
    expect(tRu("mcp.tools", { n: 3 })).not.toBe(tRu("mcp.tools", { n: 5 }));
  });

  it("no hard-coded Cyrillic strings outside i18n/ru.ts", () => {
    const root = join(import.meta.dirname, "..");
    const offenders = sourceFiles(root)
      .filter((f) => !f.endsWith(`${sep}i18n${sep}ru.ts`))
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .map((line, i) => (CYRILLIC.test(line) ? `${relative(root, f)}:${i + 1}` : ""))
          .filter(Boolean),
      );
    expect(offenders).toEqual([]);
  });
});
