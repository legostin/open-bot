import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { PathDenied, isInside, resolveAllowedPath, resolveWorkspace } from "../src/guard.ts";

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "obn-guard-")));
const allowed = join(root, "allowed");
const outside = join(root, "outside");
mkdirSync(join(allowed, "sub"), { recursive: true });
mkdirSync(outside, { recursive: true });
mkdirSync(join(root, "allowed-evil"), { recursive: true });
writeFileSync(join(allowed, "a.txt"), "a");
writeFileSync(join(outside, "secret.txt"), "secret");

/** Directory links: junctions on Windows (no admin rights needed), symlinks elsewhere. */
function dirLink(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("isInside", () => {
  it("handles equality, children and sibling prefixes", () => {
    expect(isInside(allowed, allowed)).toBe(true);
    expect(isInside(join(allowed, "x", "y"), allowed)).toBe(true);
    expect(isInside(join(root, "allowed-evil"), allowed)).toBe(false);
    expect(isInside(root, allowed)).toBe(false);
  });
});

describe("resolveAllowedPath", () => {
  const dirs = [allowed];

  it("accepts existing and new paths inside an allowed dir", () => {
    expect(resolveAllowedPath(join(allowed, "a.txt"), dirs)).toBe(join(allowed, "a.txt"));
    expect(resolveAllowedPath(join(allowed, "new", "deep", "f.txt"), dirs)).toBe(join(allowed, "new", "deep", "f.txt"));
    expect(resolveAllowedPath(allowed, dirs)).toBe(allowed);
  });

  it("resolves relative paths against the first allowed dir", () => {
    expect(resolveAllowedPath("sub/x.txt", dirs)).toBe(join(allowed, "sub", "x.txt"));
    expect(resolveAllowedPath(".", dirs)).toBe(allowed);
  });

  it("rejects paths outside, including sibling dirs sharing a prefix", () => {
    expect(() => resolveAllowedPath(join(outside, "secret.txt"), dirs)).toThrow(PathDenied);
    expect(() => resolveAllowedPath(join(root, "allowed-evil", "x"), dirs)).toThrow(/outside the allowed/);
    expect(() => resolveAllowedPath(root, dirs)).toThrow(PathDenied);
  });

  it('rejects ".." segments even when they would stay inside', () => {
    expect(() => resolveAllowedPath(`${allowed}${sep}..${sep}outside${sep}secret.txt`, dirs)).toThrow(/must not contain/);
    expect(() => resolveAllowedPath("../outside/secret.txt", dirs)).toThrow(PathDenied);
    expect(() => resolveAllowedPath("sub/../a.txt", dirs)).toThrow(PathDenied);
  });

  it("rejects symlink escapes for reads and for new files", () => {
    dirLink(outside, join(allowed, "link"));
    expect(() => resolveAllowedPath(join(allowed, "link", "secret.txt"), dirs)).toThrow(/outside the allowed/);
    expect(() => resolveAllowedPath(join(allowed, "link", "new.txt"), dirs)).toThrow(/outside the allowed/);
    expect(() => resolveAllowedPath(join(allowed, "link"), dirs)).toThrow(PathDenied);
  });

  it("follows links that stay inside", () => {
    dirLink(join(allowed, "sub"), join(allowed, "inner"));
    expect(resolveAllowedPath(join(allowed, "inner", "f.txt"), dirs)).toBe(join(allowed, "sub", "f.txt"));
  });

  it("rejects a dangling link (writing through it would land anywhere)", () => {
    const gone = join(root, "gone");
    mkdirSync(gone);
    dirLink(gone, join(allowed, "dangling"));
    rmSync(gone, { recursive: true, force: true });
    expect(() => resolveAllowedPath(join(allowed, "dangling", "x.txt"), dirs)).toThrow(PathDenied);
  });

  it("refuses denied dirs inside allowed ones (the daemon's home)", () => {
    const home = join(allowed, ".piomio-node");
    mkdirSync(home, { recursive: true });
    expect(() => resolveAllowedPath(join(home, "policy.json"), dirs, { deny: [home] })).toThrow(/state folder/);
    expect(resolveAllowedPath(join(allowed, "a.txt"), dirs, { deny: [home] })).toBe(join(allowed, "a.txt"));
  });

  it("rejects empty input and missing allowed dirs", () => {
    expect(() => resolveAllowedPath("", dirs)).toThrow(PathDenied);
    expect(() => resolveAllowedPath(undefined, dirs)).toThrow(PathDenied);
    expect(() => resolveAllowedPath("a.txt", [join(root, "missing")])).toThrow(/no usable/);
  });

  it.runIf(process.platform === "win32")("is case-insensitive on Windows and refuses device paths", () => {
    expect(resolveAllowedPath(join(allowed.toUpperCase(), "a.txt"), dirs).toLowerCase()).toBe(join(allowed, "a.txt").toLowerCase());
    expect(() => resolveAllowedPath("\\\\.\\PhysicalDrive0", dirs)).toThrow(PathDenied);
    expect(() => resolveAllowedPath(join(allowed, "a.txt:stream"), dirs)).toThrow(PathDenied);
  });
});

describe("resolveWorkspace", () => {
  const wsRoot = join(root, "workspaces");

  it("maps a relative key below the root and creates it", () => {
    const p = resolveWorkspace("assistant/c_123", wsRoot);
    expect(p).toBe(join(wsRoot, "assistant", "c_123"));
    expect(existsSync(p)).toBe(true);
  });

  it("rejects absolute keys, '..' and odd characters", () => {
    for (const bad of ["../escape", "/etc", "C:\\Windows", "a/../b", "a\\b", "", ".", "a//b", "a/./b", "x:y"]) {
      expect(() => resolveWorkspace(bad, wsRoot), bad).toThrow(PathDenied);
    }
  });
});
