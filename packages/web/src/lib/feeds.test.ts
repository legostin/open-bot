import { describe, expect, it } from "vitest";
import { cadenceOf, CADENCES, feedForPath, feedPath } from "./feeds";

describe("channels in the web UI", () => {
  it("knows the schedules the form offers and nothing else", () => {
    expect(cadenceOf({ times: ["08:00", "19:00"], weekdays: [] })).toBe("twice");
    expect(cadenceOf(CADENCES.weekly)).toBe("weekly");
    expect(cadenceOf({ times: ["07:30"], weekdays: [] })).toBeUndefined();
  });

  it("opens a channel by its path", () => {
    expect(feedPath("f_1")).toBe("/channels/f_1");
    expect(feedForPath("/channels/f_1")).toBe("f_1");
    expect(feedForPath("/channels/f_1/")).toBe("f_1");
    expect(feedForPath("/chat/c_1")).toBeUndefined();
  });
});
