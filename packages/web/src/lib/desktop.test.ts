import { describe, expect, it } from "vitest";
import { approvalLink, desktopApp, desktopTicketFrom, onAnotherComputer, pairLink } from "./desktop";

describe("desktop app links", () => {
  it("reads a sign-in ticket from the address fragment", () => {
    const t = "A1_-".repeat(11);
    expect(desktopTicketFrom(`#desktop=${t}`)).toBe(t);
    expect(desktopTicketFrom("#desktop=short")).toBeUndefined();
    expect(desktopTicketFrom("#setup=abcdefgh")).toBeUndefined();
    expect(desktopTicketFrom("")).toBeUndefined();
  });

  it("builds the pairing link the app opens", () => {
    expect(pairLink("https://bot.example.com", "AB12CD34")).toBe("owlbot://pair?hub=https%3A%2F%2Fbot.example.com&code=AB12CD34");
    expect(pairLink("http://localhost:41790", "x", "owlbot-test")).toBe("owlbot-test://pair?hub=http%3A%2F%2Flocalhost%3A41790&code=x");
  });

  it("asks the app to answer an approval card", () => {
    const app = { scheme: "owlbot", test: false, approvals: true };
    expect(approvalLink(app, "a_1", "approve")).toBe("owlbot://approval?id=a_1&decision=approve");
    expect(approvalLink(app, "a_1", "approve", true)).toBe("owlbot://approval?id=a_1&decision=approve&remember=1");
  });

  it("knows the app window it runs in", () => {
    expect(desktopApp({})).toBeUndefined();
    expect(desktopApp({ owlbotDesktop: { scheme: "owlbot", test: false } })).toEqual({ scheme: "owlbot", test: false, approvals: false });
    expect(desktopApp({ owlbotDesktop: { scheme: "owlbot-test", test: true, approvals: true } })).toEqual({ scheme: "owlbot-test", test: true, approvals: true });
    expect(desktopApp({ owlbotDesktop: { scheme: "javascript" } })).toBeUndefined();
  });

  it("offers to connect the computer the web UI is open on, unless it is the hub's own or a phone", () => {
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15";
    expect(onAnotherComputer("owlbot.tail1234.ts.net", mac, {})).toBe(true);
    expect(onAnotherComputer("192.168.1.2", mac, {})).toBe(true);
    expect(onAnotherComputer("localhost", mac, {})).toBe(false);
    expect(onAnotherComputer("127.0.0.1", mac, {})).toBe(false);
    expect(onAnotherComputer("owlbot.tail1234.ts.net", "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)", {})).toBe(false);
    expect(onAnotherComputer("owlbot.tail1234.ts.net", mac, { owlbotDesktop: { scheme: "owlbot" } })).toBe(false);
  });
});
