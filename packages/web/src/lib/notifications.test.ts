import { describe, expect, it } from "vitest";
import { dayLabel, groupByDay, partKind, sourceLabel } from "./notifications";

describe("notification views", () => {
  it("reads parts saved before kinds by their level", () => {
    expect(partKind({ level: "digest" })).toBe("digest");
    expect(partKind({ level: "ask" })).toBe("question");
    expect(partKind({ level: "notify" })).toBe("alert");
    expect(partKind({ level: "notify", kind: "report" })).toBe("report");
  });

  it("labels a source with its count when there is more than one", () => {
    expect(sourceLabel({ label: "\u041d\u043e\u0432\u043e\u0441\u0442\u0438 \u0410\u043b\u043c\u0430\u0442\u044b", count: 3 })).toBe("\u041d\u043e\u0432\u043e\u0441\u0442\u0438 \u0410\u043b\u043c\u0430\u0442\u044b · 3");
    expect(sourceLabel({ label: "Calendar" })).toBe("Calendar");
    expect(sourceLabel({ label: "Scout", count: 1 })).toBe("Scout");
  });

  it("groups entries by the person's day and names today and yesterday", () => {
    const list = [
      { id: "a", createdAt: "2026-10-31T19:30:00Z" },
      { id: "b", createdAt: "2026-10-31T03:00:00Z" },
      { id: "c", createdAt: "2026-10-30T20:00:00Z" },
    ];
    // Almaty is UTC+5: 19:30Z is already 1 November there, 20:00Z on the 30th is the 31st.
    expect(groupByDay(list, "Asia/Almaty").map((g) => [g.day, g.entries.map((e) => e.id)])).toEqual([
      ["2026-11-01", ["a"]],
      ["2026-10-31", ["b", "c"]],
    ]);
    const now = new Date("2026-11-01T06:00:00Z");
    const words = { today: "Today", yesterday: "Yesterday" };
    expect(dayLabel("2026-11-01", now, "Asia/Almaty", "en", words)).toBe("Today");
    expect(dayLabel("2026-10-31", now, "Asia/Almaty", "en", words)).toBe("Yesterday");
    expect(dayLabel("2026-10-29", now, "Asia/Almaty", "ru", words)).toBe("29 \u043e\u043a\u0442\u044f\u0431\u0440\u044f");
  });
});
