import { describe, expect, it } from "vitest";
import { renderTemplate } from "../src/util.ts";

describe("renderTemplate", () => {
  it("fills fields, nested fields and the host of URL fields", () => {
    const input = { to: "a@b.c", page: { url: "https://Shop.Example:8443/cart?x=1" }, label: "Pay", n: 3 };
    expect(renderTemplate("Send to {to} ({n})", input)).toBe("Send to a@b.c (3)");
    expect(renderTemplate("{label} on {page.url|host}", input)).toBe("Pay on shop.example");
    // Not a URL: the value itself; missing: empty; unknown filters stay literal.
    expect(renderTemplate("{label|host}", input)).toBe("Pay");
    expect(renderTemplate("[{missing|host}]", input)).toBe("[]");
    expect(renderTemplate("{label|upper}", input)).toBe("{label|upper}");
  });
});
