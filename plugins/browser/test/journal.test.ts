import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepeats, Journal, routineKeys, similar } from "../server/journal.ts";
import type { Recording, Step } from "../server/recorder.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 20, 9, 0);

function journal(now: () => number = () => T0) {
  return new Journal({ dir: join(mkdtempSync(join(tmpdir(), "browser-journal-")), "journal"), now });
}

const click = (name: string, at = T0): Step => ({ kind: "click", at, target: { role: "button", name }, count: 1 });

function order(id: string, at: number, extra: Step[] = []): Recording {
  return {
    id,
    kind: "takeover",
    startedAt: at,
    endedAt: at + 60_000,
    origin: "https://water.example",
    steps: [
      { kind: "page", at, url: "https://water.example/catalog/42", title: "Каталог" },
      click("Вода 19 л", at),
      { kind: "type", at, target: { role: "textbox", name: "Количество" }, value: "2" },
      click("В корзину за 2 400 ₸", at),
      click("Оформить заказ", at),
      ...extra,
    ],
  };
}

describe("browser journal", () => {
  it("saves, lists newest first, keeps pictures with their recording and forgets them together", () => {
    const j = journal();
    const a = order(j.newId(), T0);
    const b = order(j.newId(), T0 + 1000);
    j.save(a);
    j.save(b);
    const img = j.writeImage(a.id, 1, Buffer.from("jpeg"));
    expect(img).toBe(`${a.id}-1.jpg`);
    expect(j.list().map((r) => r.id)).toEqual([b.id, a.id]);
    expect(j.get(a.id)?.steps).toHaveLength(5);
    expect(j.images(a.id)).toEqual([join(j.dir, img)]);
    expect(j.forget({ id: a.id })).toBe(1);
    expect(existsSync(join(j.dir, img))).toBe(false);
    expect(j.forget({ id: a.id })).toBe(0);
    expect(() => j.get("../../etc/passwd")).not.toThrow();
    expect(j.get("../../etc/passwd")).toBeUndefined();
  });

  it("drops sessions after 30 days and beyond the newest ones, and forgets today's on request", () => {
    let now = T0;
    const j = new Journal({ dir: join(mkdtempSync(join(tmpdir(), "browser-journal-")), "journal"), now: () => now, max: 3 });
    const old = order(j.newId(), T0);
    j.save(old);
    now = T0 + 31 * DAY;
    const ids = [1, 2, 3, 4].map((i) => {
      const r = order(j.newId(), now - (5 - i) * 1000);
      j.save(r);
      return r.id;
    });
    expect(j.get(old.id)).toBeUndefined();
    expect(j.list().map((r) => r.id)).toEqual(ids.slice(1).reverse());
    const yesterday = order(j.newId(), now - DAY - 1000);
    j.save(yesterday);
    expect(j.forget({ day: "today" })).toBeGreaterThan(0);
    expect(j.list().map((r) => r.id)).toEqual([]);
  });

  it("tells the same routine from a different one, prices and ids aside", () => {
    const a = routineKeys(order("rec-a", T0));
    const b = routineKeys(order("rec-b", T0, [click("Мои адреса")]));
    expect(a).toEqual(["p:water.example/catalog", "c:button:вода # л", "t:textbox:количество", "c:button:в корзину за # ₸", "c:button:оформить заказ"]);
    expect(similar(a, b)).toBe(true);
    const other = routineKeys({ steps: [click("Войти"), click("Профиль"), click("Выйти")] });
    expect(similar(a, other)).toBe(false);
    // The same controls in another order are another routine.
    expect(similar(["c:a", "c:b", "c:c", "c:d"], ["c:d", "c:c", "c:b", "c:a"])).toBe(false);
    // Too short to be a routine.
    expect(similar(["c:a", "c:b"], ["c:a", "c:b"])).toBe(false);
  });

  it("offers a routine seen three times or twice on different days, once a week, never after a no", () => {
    const routines = { dismissed: [], offered: [] };
    const first = order("rec-1", T0);
    const sameDay = order("rec-2", T0 + 3_600_000);
    expect(findRepeats([first], sameDay, routines, T0)).toBeNull();
    const third = order("rec-3", T0 + 7_200_000);
    expect(findRepeats([first, sameDay], third, routines, T0)?.map((r) => r.id)).toEqual(["rec-1", "rec-2"]);
    const nextWeek = order("rec-4", T0 + 7 * DAY);
    expect(findRepeats([first], nextWeek, routines, T0)?.map((r) => r.id)).toEqual(["rec-1"]);
    // A demonstration is not free use.
    expect(findRepeats([first], { ...nextWeek, kind: "teach" }, routines, T0)).toBeNull();

    let now = T0 + 7 * DAY;
    const j = journal(() => now);
    j.save(first);
    j.save(nextWeek);
    expect(j.repeatsOf(nextWeek)?.map((r) => r.id)).toEqual(["rec-1"]);
    // Offered: not again this week…
    const again = order("rec-5", now + DAY);
    j.save(again);
    now += DAY;
    expect(j.repeatsOf(again)).toBeNull();
    // …and never once the person said no.
    now += 8 * DAY;
    expect(j.dismiss("rec-5")).toBe(true);
    const later = order("rec-6", now);
    j.save(later);
    expect(j.repeatsOf(later)).toBeNull();
  });
});
