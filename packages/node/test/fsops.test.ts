import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePolicy, type Policy } from "../src/policy.ts";
import { FsDenied, fsList, fsRead, fsWrite } from "../src/fsops.ts";
import { PathDenied } from "../src/guard.ts";

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "obn-fs-")));
const allowed = join(root, "allowed");
const outside = join(root, "outside");
mkdirSync(allowed, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, "secret.txt"), "secret");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const policy = (fs: Record<string, boolean> = {}): Policy => normalizePolicy({ allowedDirs: [allowed], fs }, root);

describe("fs inside allowed dirs", () => {
  const p = policy();

  it("writes (creating parents) and reads back UTF-8 text", () => {
    const text = "привет, мир\nline 2";
    const w = fsWrite({ path: join(allowed, "notes", "deep", "a.txt"), content: text }, p, {});
    expect(w.bytes).toBe(Buffer.byteLength(text));
    expect(readFileSync(join(allowed, "notes", "deep", "a.txt"), "utf8")).toBe(text);
    expect(fsRead({ path: join(allowed, "notes", "deep", "a.txt") }, p, {}).content).toBe(text);
    expect(fsRead({ path: "notes/deep/a.txt" }, p, {}).content).toBe(text);
  });

  it("lists a directory: dirs first, files with sizes", () => {
    writeFileSync(join(allowed, "b.txt"), "12345");
    mkdirSync(join(allowed, "zdir"), { recursive: true });
    const { entries } = fsList({ path: allowed }, p, {});
    expect(entries[0].type).toBe("dir");
    expect(entries).toContainEqual({ name: "b.txt", type: "file", size: 5 });
    expect(entries).toContainEqual({ name: "zdir", type: "dir" });
    expect(entries).toContainEqual({ name: "notes", type: "dir" });
  });

  it("gives clear errors for missing files, dirs and binary files", () => {
    expect(() => fsRead({ path: join(allowed, "missing.txt") }, p, {})).toThrow(/not found/);
    expect(() => fsRead({ path: allowed }, p, {})).toThrow(/folder, not a file/);
    expect(() => fsList({ path: join(allowed, "b.txt") }, p, {})).toThrow(FsDenied);
    expect(() => fsWrite({ path: join(allowed, "zdir"), content: "x" }, p, {})).toThrow(/folder, not a file/);
    writeFileSync(join(allowed, "bin.dat"), Buffer.from([1, 2, 0, 3]));
    expect(() => fsRead({ path: join(allowed, "bin.dat") }, p, {})).toThrow(/Binary/);
    expect(() => fsWrite({ path: join(allowed, "x.txt"), content: 42 as any }, p, {})).toThrow(/content/);
  });
});

describe("fs outside allowed dirs", () => {
  const p = policy();

  it("refuses reads, writes and listings outside", () => {
    expect(() => fsRead({ path: join(outside, "secret.txt") }, p, {})).toThrow(PathDenied);
    expect(() => fsWrite({ path: join(outside, "new.txt"), content: "x" }, p, {})).toThrow(PathDenied);
    expect(() => fsList({ path: outside }, p, {})).toThrow(PathDenied);
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
  });

  it("refuses writes through a link that points outside", () => {
    symlinkSync(outside, join(allowed, "out-link"), process.platform === "win32" ? "junction" : "dir");
    expect(() => fsWrite({ path: join(allowed, "out-link", "evil.txt"), content: "x" }, p, {})).toThrow(PathDenied);
    expect(() => fsRead({ path: join(allowed, "out-link", "secret.txt") }, p, {})).toThrow(PathDenied);
    expect(existsSync(join(outside, "evil.txt"))).toBe(false);
  });

  it("never touches the daemon's own home", () => {
    const home = join(allowed, ".piomio-node");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "policy.json"), "{}");
    expect(() => fsWrite({ path: join(home, "policy.json"), content: "{}" }, p, { deny: [home] })).toThrow(/state folder/);
    expect(() => fsRead({ path: join(home, "policy.json") }, p, { deny: [home] })).toThrow(/state folder/);
  });
});

describe("fs policy switches", () => {
  it("fs.write = false refuses writes but allows reads", () => {
    const p = policy({ write: false });
    expect(() => fsWrite({ path: join(allowed, "w.txt"), content: "x" }, p, {})).toThrow(/fs.write = false/);
    expect(() => fsList({ path: allowed }, p, {})).not.toThrow();
  });

  it("fs.read = false refuses reads and listings", () => {
    const p = policy({ read: false });
    expect(() => fsRead({ path: join(allowed, "b.txt") }, p, {})).toThrow(/fs.read = false/);
    expect(() => fsList({ path: allowed }, p, {})).toThrow(FsDenied);
  });
});
