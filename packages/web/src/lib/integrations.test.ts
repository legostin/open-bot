import { describe, expect, it } from "vitest";
import { keyExpiresSoon, openedThroughLink, primaryAction, remoteStep } from "./integrations";

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
    // Access from anywhere has its own steps, "off" included.
    expect(primaryAction({ connect: "remote", status: "off" })).toBeUndefined();
    expect(primaryAction({ connect: "remote", status: "needs-setup" })).toBeUndefined();
  });

  it("walks access from anywhere step by step", () => {
    expect(remoteStep({ available: false, enabled: true, state: "running" })).toBe("unavailable");
    expect(remoteStep({ available: true, enabled: false, state: "off" })).toBe("off");
    expect(remoteStep({ available: true, enabled: true, state: "off" })).toBe("starting");
    expect(remoteStep({ available: true, enabled: true, state: "starting" })).toBe("starting");
    expect(remoteStep({ available: true, enabled: true, state: "needs-login" })).toBe("login");
    expect(remoteStep({ available: true, enabled: true, state: "needs-funnel" })).toBe("funnel");
    expect(remoteStep({ available: true, enabled: true, state: "running" })).toBe("running");
    expect(remoteStep({ available: true, enabled: true, state: "error" })).toBe("error");
  });

  it("warns two weeks before Tailscale asks to sign in again", () => {
    const now = Date.parse("2026-10-27T12:00:00Z");
    expect(keyExpiresSoon(undefined, now)).toBe(false);
    expect(keyExpiresSoon("2027-04-25T00:00:00Z", now)).toBe(false);
    expect(keyExpiresSoon("2026-11-05T00:00:00Z", now)).toBe(true);
    expect(keyExpiresSoon("2026-10-01T00:00:00Z", now)).toBe(true);
  });

  it("knows when the page came through the link", () => {
    expect(openedThroughLink("https://piomio.tail1234.ts.net", "piomio.tail1234.ts.net")).toBe(true);
    expect(openedThroughLink("https://piomio.tail1234.ts.net", "127.0.0.1:8080")).toBe(false);
    expect(openedThroughLink(undefined, "piomio.tail1234.ts.net")).toBe(false);
  });
});
