import { describe, expect, it } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkUserKeychains } from "../src/plugins/keychains.ts";

describe("brain host keychains", () => {
  const dirs = () => {
    const root = mkdtempSync(join(tmpdir(), "owl-kc-"));
    const user = join(root, "user");
    mkdirSync(join(user, "Library", "Keychains"), { recursive: true });
    return { home: join(root, "home", "agent"), user };
  };

  it("links the user's keychains into the brain host's home on macOS, once", () => {
    const { home, user } = dirs();
    expect(linkUserKeychains(home, user, "darwin")).toBe(true);
    expect(lstatSync(join(home, "Library", "Keychains")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(home, "Library", "Keychains"))).toBe(join(user, "Library", "Keychains"));
    expect(linkUserKeychains(home, user, "darwin")).toBe(true);
  });

  it("does nothing elsewhere, or when the user has no keychains", () => {
    const { home, user } = dirs();
    expect(linkUserKeychains(home, user, "linux")).toBe(false);
    expect(linkUserKeychains(home, join(user, "nobody"), "darwin")).toBe(false);
  });
});
