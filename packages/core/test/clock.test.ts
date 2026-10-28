import { describe, expect, it } from "vitest";
import { nowLine, TurnClock } from "../src/clock.ts";

describe("turn clock", () => {
  const t0 = new Date("2026-10-27T04:15:00Z");

  it("writes the local time in English", () => {
    expect(nowLine("Asia/Almaty", t0)).toBe("[Now: Tuesday, 27 October 2026, 09:15 (Asia/Almaty)]");
    expect(nowLine("UTC", t0)).toBe("[Now: Tuesday, 27 October 2026, 04:15 (UTC)]");
  });

  it("gives a session the time on its first turn and again after ten minutes", () => {
    const clock = new TurnClock();
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    expect(clock.line("s1", "UTC", at(0))).toBe(nowLine("UTC", at(0)));
    expect(clock.line("s1", "UTC", at(9))).toBeUndefined();
    expect(clock.line("s2", "UTC", at(9))).toBe(nowLine("UTC", at(9)));
    expect(clock.line("s1", "UTC", at(10))).toBe(nowLine("UTC", at(10)));
    expect(clock.line("s1", "UTC", at(15))).toBeUndefined();
    clock.forget("s1");
    expect(clock.line("s1", "UTC", at(16))).toBe(nowLine("UTC", at(16)));
  });
});
