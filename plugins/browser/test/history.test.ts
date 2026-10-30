import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryStore } from "../server/history.ts";

const DAY = 86_400_000;

function store(opts: { now?: () => number; maxVisits?: number } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), "browser-history-")), "history.json");
  return { file, h: new HistoryStore({ file, writeDelayMs: 0, ...opts }) };
}

describe("browser history", () => {
  it("records pages once per stay and fills the title in later", () => {
    const { h } = store();
    h.record({ url: "https://example.com/", by: "user", tab: "t1" });
    h.record({ url: "https://example.com/", by: "user", tab: "t1" });
    h.record({ url: "https://example.com/", by: "assistant", tab: "t2" });
    h.record({ url: "about:blank", by: "user", tab: "t1" });
    h.record({ url: "chrome-error://chromewebdata/", by: "user", tab: "t1" });
    h.setTitle("https://example.com/", "Example");
    const { visits, more } = h.search({});
    expect(more).toBe(false);
    expect(visits.map((v) => [v.url, v.by, v.title])).toEqual([
      ["https://example.com/", "assistant", "Example"],
      ["https://example.com/", "user", ""],
    ]);
  });

  it("keeps a page that rewrote its own address right after opening as one visit", () => {
    let now = 1_000_000;
    const { h } = store({ now: () => now });
    h.record({ url: "https://ru.wikipedia.org/wiki/%D0%A1%D0%BE%D0%B2%D1%8B", by: "user", tab: "1" });
    now += 1500;
    h.record({ url: "https://ru.wikipedia.org/wiki/Owls", by: "user", tab: "1", sameDocument: true });
    // Later, an address change inside the page (a single-page app) is a page of its own; a new document always is.
    now += 10_000;
    h.record({ url: "https://ru.wikipedia.org/wiki/Owls#Range", by: "user", tab: "1", sameDocument: true });
    now += 100;
    h.record({ url: "https://ru.wikipedia.org/wiki/Hawks", by: "user", tab: "1" });
    expect(h.search({}).visits.map((v) => [v.url, v.at])).toEqual([
      ["https://ru.wikipedia.org/wiki/Hawks", 1_011_600],
      ["https://ru.wikipedia.org/wiki/Owls#Range", 1_011_500],
      ["https://ru.wikipedia.org/wiki/Owls", 1_000_000],
    ]);
  });

  it("finds pages by words in the title or the address, newest first, page by page", () => {
    let now = 1_000_000;
    const { h } = store({ now: () => now });
    for (let i = 0; i < 5; i++) {
      now += 1000;
      h.record({ url: `https://ru.wikipedia.org/wiki/${encodeURIComponent("Сова")}_${i}`, title: `Сова ${i} — Википедия`, by: "user", tab: String(i) });
    }
    h.record({ url: "https://maps.example/", title: "Карты", by: "assistant", tab: "x" });
    expect(h.search({ q: "сова википедия" }).visits).toHaveLength(5);
    // Cyrillic in the path is found as people read it, not as %D0%A1….
    expect(h.search({ q: "wiki/сова_3" }).visits.map((v) => v.title)).toEqual(["Сова 3 — Википедия"]);
    const first = h.search({ q: "сова", limit: 2 });
    expect(first.more).toBe(true);
    expect(first.visits.map((v) => v.title)).toEqual(["Сова 4 — Википедия", "Сова 3 — Википедия"]);
    const next = h.search({ q: "сова", limit: 2, before: first.visits[1].at });
    expect(next.visits.map((v) => v.title)).toEqual(["Сова 2 — Википедия", "Сова 1 — Википедия"]);
  });

  it("suggests the pages people open most, those starting with what they type first", () => {
    let now = 1_000_000;
    const { h } = store({ now: () => now });
    const visit = (url: string, title: string) => {
      now += 1000;
      h.record({ url, title, by: "user", tab: String(now) });
    };
    visit("https://news.example/wiki", "Wiki news");
    visit("https://ru.wikipedia.org/", "Википедия");
    visit("https://ru.wikipedia.org/", "Википедия");
    visit("https://www.wikihow.com/", "wikiHow");
    const urls = h.suggest("wiki").map((v) => v.url);
    expect(urls).toEqual(["https://ru.wikipedia.org/", "https://www.wikihow.com/", "https://news.example/wiki"]);
    expect(h.suggest("wiki", 1)).toHaveLength(1);
    expect(h.suggest("  ")).toEqual([]);
  });

  it("names the most visited sites once each", () => {
    let now = 1_000_000;
    const { h } = store({ now: () => now });
    for (const [url, title] of [
      ["https://a.example/x", "A page"],
      ["https://a.example/", "A home"],
      ["https://a.example/y", "Another A"],
      ["https://b.example/q", "B result"],
    ]) {
      now += 1000;
      h.record({ url, title, by: "user", tab: String(now), icon: url.includes("a.example") ? "https://a.example/favicon.ico" : undefined });
    }
    expect(h.top().map((s) => [s.url, s.title, s.icon])).toEqual([
      ["https://a.example/", "A home", "https://a.example/favicon.ico"],
      ["https://b.example/", "b.example", undefined],
    ]);
  });

  it("deletes one page, the matching ones or all of them", () => {
    const { h } = store();
    h.record({ url: "https://a.example/", title: "A", by: "user", tab: "1" });
    h.record({ url: "https://b.example/", title: "B", by: "user", tab: "1" });
    h.record({ url: "https://c.example/", title: "C", by: "user", tab: "1" });
    const [c] = h.search({}).visits;
    expect(h.remove(c.id)).toBe(true);
    expect(h.remove("nope")).toBe(false);
    expect(h.clear({ q: "b.example" })).toBe(1);
    expect(h.search({}).visits.map((v) => v.title)).toEqual(["A"]);
    expect(h.clear()).toBe(1);
    expect(h.search({}).visits).toEqual([]);
  });

  it("forgets pages older than 90 days and keeps at most the newest visits", () => {
    let now = 200 * DAY;
    const { h } = store({ now: () => now, maxVisits: 3 });
    h.record({ url: "https://old.example/", by: "user", tab: "1" });
    now += 91 * DAY;
    for (const n of [1, 2, 3, 4]) h.record({ url: `https://n${n}.example/`, by: "user", tab: "1" });
    expect(h.search({}).visits.map((v) => v.url)).toEqual(["https://n4.example/", "https://n3.example/", "https://n2.example/"]);
  });

  it("keeps the history in its file", () => {
    const { file, h } = store();
    h.record({ url: "https://a.example/", title: "A", by: "assistant", tab: "1" });
    h.flush();
    expect(JSON.parse(readFileSync(file, "utf8")).visits).toHaveLength(1);
    const again = new HistoryStore({ file });
    expect(again.search({}).visits.map((v) => [v.url, v.title, v.by])).toEqual([["https://a.example/", "A", "assistant"]]);
  });
});
