import { describe, expect, it } from "vitest";
import { desktopTicketFrom, pairLink } from "./desktop";

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
  });
});
