import { describe, expect, it } from "vitest";
import { primaryAction } from "./integrations";

describe("integration cards", () => {
  it("offers the one button that moves each card forward", () => {
    expect(primaryAction({ connect: "google", status: "needs-setup" })).toBe("connect");
    expect(primaryAction({ connect: "google", status: "broken" })).toBe("reconnect");
    expect(primaryAction({ connect: "google", status: "connected" })).toBe("disconnect");
    expect(primaryAction({ connect: "google", status: "unavailable" })).toBeUndefined();
    expect(primaryAction({ connect: "setup", status: "needs-setup" })).toBe("setup");
    expect(primaryAction({ connect: "setup", status: "connected" })).toBe("setup");
    expect(primaryAction({ connect: "none", status: "connected" })).toBeUndefined();
    expect(primaryAction({ connect: "none", status: "off" })).toBe("turnOn");
    expect(primaryAction({ connect: "google", status: "off" })).toBe("turnOn");
  });
});
