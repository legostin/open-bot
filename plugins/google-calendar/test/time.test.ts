import { describe, expect, it } from "vitest";
import { addDays, dayStart, parseWhen, rfc3339, span, today, zonedInstant } from "../server/time.ts";

describe("calendar times", () => {
  it("turns local times into instants and back, in any zone", () => {
    const at = zonedInstant(2026, 10, 28, 10, 0, 0, "Asia/Almaty");
    expect(new Date(at).toISOString()).toBe("2026-10-28T05:00:00.000Z");
    expect(rfc3339(at, "Asia/Almaty")).toBe("2026-10-28T10:00:00+05:00");
    expect(rfc3339(zonedInstant(2026, 7, 1, 9, 30, 0, "America/New_York"), "America/New_York")).toBe("2026-07-01T09:30:00-04:00");
    expect(rfc3339(zonedInstant(2026, 1, 15, 9, 30, 0, "America/New_York"), "America/New_York")).toBe("2026-01-15T09:30:00-05:00");
    expect(rfc3339(dayStart("2026-10-28", "UTC"), "UTC")).toBe("2026-10-28T00:00:00+00:00");
  });

  it("reads what the agent writes", () => {
    expect(parseWhen("2026-10-28", "UTC")).toEqual({ date: "2026-10-28" });
    expect(parseWhen("2026-10-28T10:00", "Europe/Berlin")).toEqual({ at: Date.parse("2026-10-28T09:00:00Z") });
    expect(parseWhen("2026-10-28T10:00:00Z", "Europe/Berlin")).toEqual({ at: Date.parse("2026-10-28T10:00:00Z") });
    expect(parseWhen("tomorrow", "UTC")).toBeUndefined();
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(today("Asia/Almaty", Date.parse("2026-10-27T20:00:00Z"))).toBe("2026-10-28");
  });

  it("describes events for the model", () => {
    expect(span({ dateTime: "2026-10-28T10:00:00+05:00" }, { dateTime: "2026-10-28T11:30:00+05:00" }, "Asia/Almaty")).toBe("Wed 28 Oct 10:00–11:30");
    expect(span({ date: "2026-10-28" }, { date: "2026-10-29" }, "UTC")).toBe("Wed 28 Oct, all day");
    expect(span({ date: "2026-10-28" }, { date: "2026-10-31" }, "UTC")).toBe("Wed 28 Oct – Fri 30 Oct, all day");
    expect(span({ dateTime: "2026-10-28T22:00:00Z" }, { dateTime: "2026-10-29T01:00:00Z" }, "UTC")).toBe("Wed 28 Oct 22:00 – Thu 29 Oct 01:00");
  });
});
