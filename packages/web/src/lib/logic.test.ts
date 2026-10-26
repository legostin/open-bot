import { describe, expect, it } from "vitest";
import { globSpecificity, matchesAny, matchesGlob } from "./glob";
import { backoffDelay } from "./backoff";
import { applyCommand, filterCommands, slashQuery } from "./commands";
import { groupParts, inputPreview, prettyJson } from "./parts";
import { parseMcpConfig } from "./mcp-config";
import { slugify } from "./format";
import { mergeClasses } from "./classes";
import { sectionForPath } from "../components/nav";
import { AVATAR_COLORS, AVATAR_SHAPES, defaultAvatar, parseAvatar } from "@openbot/shared/avatar";

describe("glob", () => {
  it("matches * and ? case-insensitively", () => {
    expect(matchesGlob("browser_open", "browser_*")).toBe(true);
    expect(matchesGlob("Browser_Open", "browser_*")).toBe(true);
    expect(matchesGlob("browser.open", "browser.*")).toBe(true);
    expect(matchesGlob("browserXopen", "browser.*")).toBe(false);
    expect(matchesGlob("ab", "a?")).toBe(true);
    expect(matchesGlob("memory_search", "browser_*")).toBe(false);
  });
  it("accepts a string or a list", () => {
    expect(matchesAny("x_y", "x_*")).toBe(true);
    expect(matchesAny("x_y", ["a", "x_*"])).toBe(true);
    expect(matchesAny("x_y", undefined)).toBe(false);
  });
  it("ranks literal globs as more specific", () => {
    expect(globSpecificity("browser_open")).toBeGreaterThan(globSpecificity("browser_*"));
    expect(globSpecificity("*")).toBe(0);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially and caps", () => {
    const fixed = { random: () => 1 };
    expect(backoffDelay(0, fixed)).toBe(500);
    expect(backoffDelay(1, fixed)).toBe(1000);
    expect(backoffDelay(3, fixed)).toBe(4000);
    expect(backoffDelay(50, fixed)).toBe(30_000);
  });
  it("applies jitter of at most 25%", () => {
    expect(backoffDelay(2, { random: () => 0 })).toBe(1500);
  });
});

describe("slash commands", () => {
  const cmds = [
    { name: "review", description: "Review a PR" },
    { name: "deploy", description: "Ship it" },
    { name: "digest", description: "Morning review of news" },
  ];
  it("detects a /word being typed", () => {
    expect(slashQuery("/rev")).toBe("rev");
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/review now")).toBeNull();
    expect(slashQuery("hello /x")).toBeNull();
  });
  it("puts prefix matches first, then substring/description matches", () => {
    expect(filterCommands(cmds, "d").map((c) => c.name)).toEqual(["deploy", "digest"]);
    expect(filterCommands(cmds, "review").map((c) => c.name)).toEqual(["review", "digest"]);
    expect(filterCommands(cmds, "").length).toBe(3);
  });
  it("applies a command with a trailing space", () => {
    expect(applyCommand("review")).toBe("/review ");
    expect(applyCommand("/review")).toBe("/review ");
  });
});

describe("parts", () => {
  it("pairs tool calls with their results", () => {
    const items = groupParts([
      { type: "text", text: "a" },
      { type: "tool_call", id: "1", name: "x", input: {} },
      { type: "tool_result", id: "1", output: "ok" },
      { type: "tool_result", id: "2", output: "orphan" },
      { type: "error", message: "boom" },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["part", "tool", "orphan_result", "part"]);
    const tool = items[1];
    expect(tool.kind === "tool" && tool.result?.output).toBe("ok");
  });
  it("pretty-prints JSON values and JSON strings", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson("plain")).toBe("plain");
  });
  it("previews inputs on one line", () => {
    expect(inputPreview({ url: "https://x", n: 2 })).toBe('url: "https://x", n: 2');
    expect(inputPreview("a\n  b")).toBe("a b");
    expect(inputPreview({ q: "x".repeat(200) }, 20)).toHaveLength(20);
  });
});

describe("parseMcpConfig", () => {
  it("accepts .mcp.json and bare maps", () => {
    expect(parseMcpConfig('{"mcpServers":{"a":{"command":"x"}}}').servers).toEqual({ a: { command: "x" } });
    expect(parseMcpConfig('{"a":{"url":"https://x"}}').servers).toEqual({ a: { url: "https://x" } });
    expect(parseMcpConfig("").servers).toEqual({});
  });
  it("rejects invalid JSON and plaintext secrets", () => {
    expect(parseMcpConfig("{").error).toMatch(/JSON/);
    expect(parseMcpConfig('{"a":{"command":"x","env":{"API_KEY":"sk-123"}}}').error).toMatch(/vault/);
    expect(parseMcpConfig('{"a":{"command":"x","env":{"API_KEY":"vault://k"}}}').servers).toBeTruthy();
    expect(parseMcpConfig('{"a":{}}').error).toMatch(/command/);
  });
});

describe("format", () => {
  it("slugifies names (with transliteration)", () => {
    // "Issledovatel'" (researcher) in Cyrillic, escaped to keep Cyrillic out of the source.
    expect(slugify("\u0418\u0441\u0441\u043b\u0435\u0434\u043e\u0432\u0430\u0442\u0435\u043b\u044c")).toBe("issledovatel");
    expect(slugify("\u0401\u0436")).toBe("ezh");
    expect(slugify("Code Reviewer!")).toBe("code-reviewer");
  });
});

describe("mergeClasses", () => {
  const base = "w-full rounded-xl px-3 text-sm h-10 pr-8";
  it("replaces base utilities of the same group", () => {
    expect(mergeClasses(base, "h-8 w-auto rounded-lg")).toBe("px-3 text-sm pr-8 h-8 w-auto rounded-lg");
  });
  it("keeps the base when the override is a variant or another group", () => {
    expect(mergeClasses(base, "sm:w-40 font-mono")).toBe(`${base} sm:w-40 font-mono`);
    expect(mergeClasses(base, "min-w-0")).toBe(`${base} min-w-0`);
    expect(mergeClasses(base)).toBe(base);
  });
});

describe("settings panel sections", () => {
  it("maps former page URLs to panel sections", () => {
    expect(sectionForPath("/brains")).toBe("brains");
    expect(sectionForPath("/mcp-servers/")).toBe("mcp");
    expect(sectionForPath("/settings")).toBe("settings");
    expect(sectionForPath("/chat/abc")).toBeUndefined();
    expect(sectionForPath("/tasks/t1")).toBeUndefined();
  });
});

describe("agent avatars", () => {
  it("derives a stable avatar and validates picked ones", () => {
    expect(defaultAvatar("researcher")).toEqual(defaultAvatar("researcher"));
    expect(AVATAR_COLORS).toContain(defaultAvatar("x").color);
    expect(AVATAR_SHAPES).toContain(defaultAvatar("x").shape);
    expect(parseAvatar({ color: "pink", shape: "star" })).toEqual({ color: "pink", shape: "star" });
    expect(parseAvatar({ color: "pink", shape: "blob" })).toBeUndefined();
    expect(parseAvatar("pink")).toBeUndefined();
  });
});
