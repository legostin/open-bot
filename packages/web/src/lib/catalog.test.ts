import { describe, expect, it } from "vitest";
import type { CatalogSection, CatalogView, IntegrationView } from "@owlbot/shared";
import { chatStep, filterCatalog, findEntry, hasSwitch, hueOf, isOn, popularEntries, rowState } from "./catalog";

const v = (over: Partial<IntegrationView>): IntegrationView => ({ id: "x", name: "X", summary: "", category: "everyday", icon: "puzzle", connect: "none", status: "connected", ...over });

describe("catalog entries", () => {
  it("tells on from off", () => {
    expect(isOn(v({ status: "off" }))).toBe(false);
    expect(isOn(v({ status: "unavailable" }))).toBe(false);
    expect(isOn(v({ status: "needs-setup" }))).toBe(true);
    expect(isOn(v({ status: "broken" }))).toBe(true);
  });

  it("gives a switch to all but access from anywhere and what is unavailable", () => {
    expect(hasSwitch(v({}))).toBe(true);
    expect(hasSwitch(v({ connect: "google", status: "needs-setup" }))).toBe(true);
    expect(hasSwitch(v({ connect: "remote", status: "off" }))).toBe(false);
    expect(hasSwitch(v({ status: "unavailable" }))).toBe(false);
  });

  it("continues in the chat when something needs the person", () => {
    expect(chatStep(v({}))).toBeUndefined();
    expect(chatStep(v({ status: "off", connect: "google" }))).toBeUndefined();
    expect(chatStep(v({ status: "needs-setup", connect: "google" }))).toBe("connect");
    expect(chatStep(v({ status: "broken", connect: "google" }))).toBe("fix");
    expect(chatStep(v({ status: "connected", connect: "setup" }))).toBe("settings");
    expect(chatStep(v({ status: "off", connect: "remote" }))).toBe("connect");
    expect(chatStep(v({ status: "connected", connect: "remote" }))).toBe("settings");
    expect(chatStep(v({ status: "unavailable", connect: "remote" }))).toBeUndefined();
  });

  it("searches names, lines and situations", () => {
    const sections: CatalogSection[] = [
      { id: "everyday", title: "Everyday", items: [v({ id: "weather", name: "Weather", summary: "The forecast" }), v({ id: "holidays", name: "Holidays", summary: "Days off" })] },
      { id: "money", title: "Money", items: [v({ id: "currency", name: "Currency rates", summary: "Convert any sum" })] },
    ];
    expect(filterCatalog(sections, "")).toBe(sections);
    expect(filterCatalog(sections, "forecast").map((s) => s.items.map((i) => i.id))).toEqual([["weather"]]);
    expect(filterCatalog(sections, "money").map((s) => s.id)).toEqual(["money"]);
    expect(filterCatalog(sections, "days EVERYDAY").flatMap((s) => s.items.map((i) => i.id))).toEqual(["holidays"]);
    expect(filterCatalog(sections, "nothing like it")).toEqual([]);
  });

  it("colours unknown situations like the others group", () => {
    expect(hueOf("money")).not.toBe(hueOf("travel"));
    expect(hueOf("whatever")).toBe(hueOf("other"));
  });

  it("marks a row on, waiting for the person or broken, and leaves an off one bare", () => {
    expect(rowState(v({}))).toBe("on");
    expect(rowState(v({ status: "needs-setup" }))).toBe("attention");
    expect(rowState(v({ status: "broken" }))).toBe("broken");
    expect(rowState(v({ status: "off" }))).toBeUndefined();
    expect(rowState(v({ status: "unavailable" }))).toBeUndefined();
  });

  it("finds the popular entries in their order, with the situation each is listed under", () => {
    const c: CatalogView = {
      popular: ["currency", "gone", "weather"],
      sections: [
        { id: "everyday", title: "Everyday", items: [v({ id: "weather" })] },
        { id: "money", title: "Money", items: [v({ id: "currency" })] },
      ],
    };
    expect(popularEntries(c).map((p) => [p.entry.id, p.situation])).toEqual([
      ["currency", "money"],
      ["weather", "everyday"],
    ]);
    expect(findEntry(c, "weather")?.situation).toBe("everyday");
    expect(findEntry(c, "gone")).toBeUndefined();
  });
});
