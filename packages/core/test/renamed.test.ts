import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbFile, openDb } from "../src/db.ts";
import { EventBus } from "../src/bus.ts";
import { Pages } from "../src/pages.ts";

describe("an Owlbot hub's data", () => {
  it("is taken over under the new name, the write-ahead log with it", () => {
    const dir = mkdtempSync(join(tmpdir(), "piomio-renamed-"));
    const old = openDb(join(dir, "owlbot.db"));
    old.exec("create table kept(x text); insert into kept values ('conversations')");
    old.close();
    writeFileSync(join(dir, "owlbot.db-wal"), "");
    expect(hubDbFile(dir)).toBe(join(dir, "piomio.db"));
    expect(["owlbot.db", "owlbot.db-wal"].map((f) => existsSync(join(dir, f)))).toEqual([false, false]);
    expect(existsSync(join(dir, "piomio.db-wal"))).toBe(true);
    const db = openDb(hubDbFile(dir));
    expect(db.prepare("select x from kept").get()).toEqual({ x: "conversations" });
    db.close();
  });

  it("is left alone once the hub has its own database", () => {
    const dir = mkdtempSync(join(tmpdir(), "piomio-renamed-"));
    writeFileSync(join(dir, "piomio.db"), "new");
    writeFileSync(join(dir, "owlbot.db"), "old");
    expect(hubDbFile(dir)).toBe(join(dir, "piomio.db"));
    expect(readFileSync(join(dir, "piomio.db"), "utf8")).toBe("new");
    expect(existsSync(join(dir, "owlbot.db"))).toBe(true);
  });

  it("keeps the pages agents made: their code moves to the new names", () => {
    const db = openDb(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "piomio-pages-"));
    const code = `import { Hero } from "@piomio/page";\nexport default function P() { return <Hero title="Trip" />; }\n`;
    const page = new Pages({ db, bus: new EventBus(), dir }).create({ title: "Trip", code }, { agentId: "assistant" });
    const owlbot = (s: string) => s.replaceAll("@piomio/", "@owlbot/").replace(/^piomioPage\(/, "owlbotPage(");
    for (const f of ["page.tsx", "page.js"]) writeFileSync(join(dir, page.id, f), owlbot(readFileSync(join(dir, page.id, f), "utf8")));
    const pages = new Pages({ db, bus: new EventBus(), dir });
    expect(readFileSync(join(dir, page.id, "page.tsx"), "utf8")).toBe(code);
    expect(pages.script(page.id)).toMatch(/^piomioPage\(.*require\(['"]@piomio\/page['"]\)/s);
    expect(pages.get(page.id)?.version).toBe(page.version + 1);
  });
});
