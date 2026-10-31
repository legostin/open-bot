import { beforeEach, describe, expect, it } from "vitest";
import { parseRoute, routeHref } from "./route.ts";
import { conditionMatches, fieldPaths, ruleMatchesInput } from "./match.ts";
import { flattenInput, relativeTime, splitUrls, actorLabel } from "./format.ts";
import { normalizeLocale, setLocaleForTests, t, tn } from "../i18n/index.ts";
import { en } from "../i18n/en.ts";
import { ru } from "../i18n/ru.ts";
import { buildPayload, emptyDraft, parseList, passphraseStrength, slugify, validateId } from "./vault.ts";

describe("parseRoute", () => {
  it("defaults to approvals", () => {
    expect(parseRoute("")).toEqual({ page: "approvals" });
    expect(parseRoute("#/")).toEqual({ page: "approvals" });
    expect(parseRoute("#/nope")).toEqual({ page: "approvals" });
  });
  it("parses pages and ids", () => {
    expect(parseRoute("#/vault")).toEqual({ page: "vault" });
    expect(parseRoute("#/approvals/a123")).toEqual({ page: "approvals", id: "a123" });
    expect(parseRoute("#approvals/a%20b")).toEqual({ page: "approvals", id: "a b" });
    expect(parseRoute("#/audit?x=1")).toEqual({ page: "audit" });
  });
  it("does not carry an id over from an unknown page", () => {
    expect(parseRoute("#/evil/x")).toEqual({ page: "approvals" });
  });
  it("builds hrefs", () => {
    expect(routeHref("approvals", "a/b")).toBe("#/approvals/a%2Fb");
    expect(routeHref("rules")).toBe("#/rules");
  });
});

describe("conditionMatches", () => {
  const input = { to: "bob@example.com", url: "https://api.github.com/x", tags: ["a", "b"], nested: { chat: "42" } };
  it("eq / glob / domain", () => {
    expect(conditionMatches({ field: "to", op: "eq", value: "bob@example.com" }, input)).toBe(true);
    expect(conditionMatches({ field: "to", op: "eq", value: "eve@example.com" }, input)).toBe(false);
    expect(conditionMatches({ field: "to", op: "glob", value: "*@example.com" }, input)).toBe(true);
    expect(conditionMatches({ field: "to", op: "domain", value: "example.com" }, input)).toBe(true);
    expect(conditionMatches({ field: "url", op: "domain", value: "github.com" }, input)).toBe(true);
    expect(conditionMatches({ field: "url", op: "domain", value: "gitlab.com" }, input)).toBe(false);
    expect(conditionMatches({ field: "nested.chat", op: "eq", value: "42" }, input)).toBe(true);
  });
  it("max: a number (or a numeric string) no larger than the limit", () => {
    const c = { field: "amount", op: "max" as const, value: 3000 };
    expect(conditionMatches(c, { amount: 2400 })).toBe(true);
    expect(conditionMatches(c, { amount: "3000" })).toBe(true);
    expect(conditionMatches(c, { amount: 3000.5 })).toBe(false);
    expect(conditionMatches(c, { amount: "a lot" })).toBe(false);
    expect(conditionMatches(c, {})).toBe(false);
  });
  it("arrays must match in every element; missing fields never match", () => {
    expect(conditionMatches({ field: "tags", op: "glob", value: "?" }, input)).toBe(true);
    expect(conditionMatches({ field: "tags", op: "eq", value: "a" }, input)).toBe(false);
    expect(conditionMatches({ field: "missing", op: "glob", value: "*" }, input)).toBe(false);
  });
  it("rule: tool glob and agent", () => {
    const rule = { tool: "mail_*", agentId: "main", conditions: [{ field: "to", op: "domain" as const, value: "example.com" }] };
    expect(ruleMatchesInput(rule, "mail_send", "main", input)).toBe(true);
    expect(ruleMatchesInput(rule, "mail_send", "other", input)).toBe(false);
    expect(ruleMatchesInput(rule, "web_fetch", "main", input)).toBe(false);
  });
  it("lists field paths", () => {
    expect(fieldPaths(input)).toEqual(["to", "url", "tags", "nested.chat"]);
  });
});

describe("i18n", () => {
  const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(",");
  it("ru and en use the same placeholders", () => {
    for (const k of Object.keys(en) as Array<keyof typeof en>) {
      expect(placeholders(ru[k]), k).toBe(placeholders(en[k]));
    }
  });
  it("plural messages have the right number of forms", () => {
    for (const k of Object.keys(en) as Array<keyof typeof en>) {
      if (!en[k].includes("|")) continue;
      expect(en[k].split("|").length, k).toBe(2);
      expect(ru[k].split("|").length, k).toBe(3);
    }
  });
  it("t / tn", () => {
    setLocaleForTests("ru");
    expect(tn("time.minutesAgo", 1)).toBe("1 минуту назад");
    expect(tn("time.minutesAgo", 3)).toBe("3 минуты назад");
    expect(tn("time.minutesAgo", 11)).toBe("11 минут назад");
    expect(tn("time.minutesAgo", 21)).toBe("21 минуту назад");
    expect(t("vault.deleted", { id: "x" })).toBe("Запись vault://x удалена");
    setLocaleForTests("en");
    expect(tn("time.minutesAgo", 1)).toBe("1 minute ago");
    expect(tn("time.minutesAgo", 5)).toBe("5 minutes ago");
    expect(t("vault.deleted", { id: "x" })).toBe("Item vault://x deleted");
  });
  it("normalizeLocale", () => {
    expect(normalizeLocale("ru-RU")).toBe("ru");
    expect(normalizeLocale("EN")).toBe("en");
    expect(normalizeLocale("de")).toBeUndefined();
    expect(normalizeLocale(undefined)).toBeUndefined();
  });
});

describe("format", () => {
  beforeEach(() => setLocaleForTests("ru"));
  it("relativeTime", () => {
    const now = Date.parse("2026-10-26T12:00:00Z");
    expect(relativeTime("2026-10-26T11:59:50Z", now)).toBe("только что");
    expect(relativeTime("2026-10-26T11:55:00Z", now)).toBe("5 минут назад");
    setLocaleForTests("en");
    expect(relativeTime("2026-10-26T11:55:00Z", now)).toBe("5 minutes ago");
  });
  it("flattenInput", () => {
    const rows = flattenInput({ to: "a@b.c", count: 2, ok: true, cc: ["x", "y"], opts: { mode: "fast" }, empty: "", list: [{ a: 1 }] });
    expect(rows.map((r) => [r.key, r.kind])).toEqual([
      ["to", "text"],
      ["count", "number"],
      ["ok", "boolean"],
      ["cc", "list"],
      ["opts.mode", "text"],
      ["empty", "empty"],
      ["list", "json"],
    ]);
    expect(flattenInput("raw")).toEqual([{ key: "значение", kind: "text", text: "raw" }]);
  });
  it("splitUrls highlights hosts", () => {
    const parts = splitUrls("go to https://user@evil.example.com/login?x now");
    expect(parts[1].url).toEqual({ before: "https://user@", host: "evil.example.com", after: "/login?x" });
    expect(parts[0].text).toBe("go to ");
    expect(parts[2].text).toBe(" now");
  });
  it("actorLabel", () => {
    expect(actorLabel("user")).toBe("вы");
    expect(actorLabel("agent:main")).toBe("агент main");
    setLocaleForTests("en");
    expect(actorLabel("agent:main")).toBe("agent main");
  });
});

describe("vault form", () => {
  it("slugify matches the server", () => {
    expect(slugify("My GitHub Login!")).toBe("my_github_login");
    expect(slugify("Почта")).toBe("");
  });
  it("validateId", () => {
    expect(validateId("")).toBeUndefined();
    expect(validateId("github_token")).toBeUndefined();
    expect(validateId("Bad Id")).toBeTruthy();
    expect(validateId("_x")).toBeTruthy();
  });
  it("parseList", () => {
    expect(parseList("a.com, b.com\n a.com ;c")).toEqual(["a.com", "b.com", "c"]);
  });
  it("buildPayload: secret create/edit", () => {
    const d = { ...emptyDraft("secret"), name: "OpenAI", id: "openai_api_key", value: " sk-1 " };
    const r = buildPayload(d, { editing: false, existingIds: [] });
    expect(r.ok && r.payload).toMatchObject({ id: "openai_api_key", type: "secret", fields: { value: "sk-1" } });
    expect(buildPayload({ ...d, value: "" }, { editing: false, existingIds: [] }).ok).toBe(false);
    const edit = buildPayload({ ...d, value: "" }, { editing: true, existingIds: ["openai_api_key"] });
    expect(edit.ok && edit.payload.fields).toEqual({ value: "" });
  });
  it("buildPayload: refuses to overwrite an existing id on create", () => {
    const d = { ...emptyDraft("secret"), name: "GitHub", value: "x" };
    expect(buildPayload(d, { editing: false, existingIds: ["github"] }).ok).toBe(false);
  });
  it("buildPayload: login needs a url or domains", () => {
    const d = { ...emptyDraft("login"), name: "Site", password: "p" };
    expect(buildPayload(d, { editing: false, existingIds: [] }).ok).toBe(false);
    const ok = buildPayload({ ...d, url: "https://site.example" }, { editing: false, existingIds: [] });
    expect(ok.ok && ok.payload.scope?.plugins).toEqual(["browser"]);
  });
  it("buildPayload: identity rows", () => {
    const d = { ...emptyDraft("identity"), name: "Я", identity: [{ key: "email", value: "a@b.c" }, { key: "", value: "" }] };
    const r = buildPayload(d, { editing: false, existingIds: [] });
    expect(r.ok && r.payload.fields).toEqual({ email: "a@b.c" });
    expect(buildPayload({ ...d, identity: [{ key: "a", value: "1" }, { key: "a", value: "2" }] }, { editing: false, existingIds: [] }).ok).toBe(false);
  });
  it("passphraseStrength", () => {
    expect(passphraseStrength("short").score).toBe(0);
    expect(passphraseStrength("aaaaaaaa").score).toBeLessThanOrEqual(1);
    expect(passphraseStrength("correct horse battery staple").score).toBe(4);
  });
});
