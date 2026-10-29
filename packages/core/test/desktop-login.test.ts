// One-time sign-in tickets of the desktop app and the commands it sends over the hub's stdin.
import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { DesktopApprover, DesktopTickets, readDesktopCommands } from "../src/desktop-login.ts";

const ticket = "a".repeat(43);

describe("desktop sign-in tickets", () => {
  it("lets a ticket in once", () => {
    const tickets = new DesktopTickets();
    tickets.add(ticket);
    expect(tickets.consume(ticket)).toBe(true);
    expect(tickets.consume(ticket)).toBe(false);
  });

  it("forgets a ticket after a minute and ignores malformed ones", () => {
    let now = 1_000;
    const tickets = new DesktopTickets(() => now);
    tickets.add(ticket);
    now += 60_001;
    expect(tickets.consume(ticket)).toBe(false);
    tickets.add("short");
    expect(tickets.consume("short")).toBe(false);
  });

  it("reads the app's lines and stops when the pipe closes", async () => {
    const input = new PassThrough();
    const seen: string[] = [];
    readDesktopCommands(input, { stop: () => seen.push("stop"), ticket: (t) => seen.push(`ticket ${t}`), approver: (k) => seen.push(`approver ${k}`) });
    input.write(`approver ${ticket}\nticket ${ticket}\nnoise\nstop\n`);
    input.end();
    await vi.waitFor(() => expect(seen).toEqual([`approver ${ticket}`, `ticket ${ticket}`, "stop", "stop"]));
  });
});

describe("the desktop app's approval key", () => {
  it("knows only the key the app gave it", () => {
    const approver = new DesktopApprover();
    expect(approver.check(ticket)).toBe(false);
    approver.set("short");
    expect(approver.enabled).toBe(false);
    approver.set(ticket);
    expect(approver.check(ticket)).toBe(true);
    expect(approver.check("b".repeat(43))).toBe(false);
    expect(approver.check(undefined)).toBe(false);
  });
});
