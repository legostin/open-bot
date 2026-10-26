import { describe, expect, it } from "vitest";
import {
  catalogProblems,
  format,
  localeFromAcceptLanguage,
  localeFromEnv,
  localizeValue,
  catalogLookup,
  normalizeLocale,
  placeholders,
  translator,
} from "../src/i18n.ts";

describe("i18n", () => {
  it("normalizes locales", () => {
    expect(normalizeLocale("ru-RU")).toBe("ru");
    expect(normalizeLocale("ru_RU.UTF-8")).toBe("ru");
    expect(normalizeLocale("EN")).toBe("en");
    expect(normalizeLocale("de")).toBeUndefined();
    expect(localeFromAcceptLanguage("de-DE,ru;q=0.9,en;q=0.8")).toBe("ru");
    expect(localeFromAcceptLanguage("de, fr;q=0.5")).toBeUndefined();
    expect(localeFromAcceptLanguage("en;q=0.2, ru;q=0.7")).toBe("ru");
    expect(localeFromEnv({ LANG: "C.UTF-8", LC_ALL: "ru_RU.UTF-8" })).toBe("ru");
    expect(localeFromEnv({ LANG: "C.UTF-8" })).toBeUndefined();
  });

  it("formats placeholders, plurals and selects", () => {
    expect(format("Hi {name}", { name: "Ann" })).toBe("Hi Ann");
    expect(format("Hi {name}")).toBe("Hi {name}");
    const files = "{n, plural, one {# файл} few {# файла} many {# файлов} other {# файла}}";
    expect(format(files, { n: 1 }, "ru")).toBe("1 файл");
    expect(format(files, { n: 3 }, "ru")).toBe("3 файла");
    expect(format(files, { n: 11 }, "ru")).toBe("11 файлов");
    expect(format("{n, plural, =0 {none} one {# item in {where}} other {# items in {where}}}", { n: 0, where: "x" })).toBe("none");
    expect(format("{n, plural, =0 {none} one {# item in {where}} other {# items in {where}}}", { n: 2, where: "x" })).toBe("2 items in x");
    expect(format("{k, select, a {Alpha} other {Other {k}}}", { k: "b" })).toBe("Other b");
  });

  it("falls back to English, then to the key", () => {
    const t = translator({ en: { a: "A {x}", b: "B" }, ru: { a: "А {x}" } }, "ru");
    expect(t("a", { x: 1 })).toBe("А 1");
    expect(t("b")).toBe("B");
    expect(t("c")).toBe("c");
  });

  it("finds catalog problems", () => {
    expect(placeholders("{a} {n, plural, one {# {b}} other {#}}")).toEqual(["a", "b", "n"]);
    const problems = catalogProblems({ en: { a: "{x}", b: "B" }, ru: { a: "{y}", c: "C" } });
    expect(problems).toEqual(['ru: "a" placeholders y ≠ en x', 'ru: missing "b"', 'ru: extra "c"']);
  });

  it("localizes %key% references in JSON values", () => {
    const manifest = { name: "%name%", settings: { properties: { a: { title: "%a.title%", enum: ["x"] } } }, other: "%missing%" };
    const out = localizeValue(manifest, catalogLookup({ en: { name: "Browser", "a.title": "Mode" }, ru: { name: "Браузер" } }, "ru"));
    expect(out).toEqual({ name: "Браузер", settings: { properties: { a: { title: "Mode", enum: ["x"] } } }, other: "%missing%" });
  });
});
