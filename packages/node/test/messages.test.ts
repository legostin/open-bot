import { afterEach, describe, expect, it } from "vitest";
import { catalogProblems } from "@owlbot/shared/i18n";
import { brainsCatalog } from "../../brains-cli/src/messages.ts";
import { hubLocale, nodeCatalog, setHubLocale, setNodeLocale, t, tHub } from "../src/messages.ts";
import { policySummary, defaultPolicy } from "../src/policy.ts";

describe("node messages", () => {
  afterEach(() => {
    setNodeLocale(undefined);
    setHubLocale(undefined);
  });

  it("has the same keys and placeholders in every language", () => {
    expect(catalogProblems(nodeCatalog)).toEqual([]);
    expect(catalogProblems(brainsCatalog)).toEqual([]);
  });

  it("speaks the local language and the hub's language separately", () => {
    setNodeLocale("ru");
    expect(t("policy.reloaded")).toBe("политика перечитана");
    expect(policySummary(defaultPolicy("/home/x"))[2]).toMatch(/^Файлы: чтение да/);
    expect(hubLocale()).toBe("ru");
    setHubLocale("en");
    expect(tHub("brains.disabled")).toBe("disabled in policy.json");
    expect(t("brains.disabled")).toBe("отключён в policy.json");
  });
});
