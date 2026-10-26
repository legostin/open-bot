import { describe, expect, it } from "vitest";
import { desktopApp, desktopTicketFrom, pairLink } from "./desktop";

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

  it("knows the app window it runs in", () => {
    expect(desktopApp({})).toBeUndefined();
    expect(desktopApp({ owlbotDesktop: { scheme: "owlbot", test: false } })).toEqual({ scheme: "owlbot", test: false });
    expect(desktopApp({ owlbotDesktop: { scheme: "owlbot-test", test: true } })).toEqual({ scheme: "owlbot-test", test: true });
    expect(desktopApp({ owlbotDesktop: { scheme: "javascript" } })).toBeUndefined();
  });
});
