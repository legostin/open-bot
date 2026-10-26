// Path guard: every path the hub asks about is resolved (symlinks included) and must stay inside the allowed dirs.

import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class PathDenied extends Error {
  code = "PATH_DENIED";
}

const WIN = process.platform === "win32";

function cmp(p: string): string {
  const r = resolve(p);
  return WIN ? r.toLowerCase() : r;
}

/** True when `child` is `parent` or below it (lexically; resolve symlinks first). */
export function isInside(child: string, parent: string): boolean {
  const c = cmp(child);
  const p = cmp(parent);
  if (c === p) return true;
  const rel = relative(p, c);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

function realpath(p: string): string {
  return realpathSync.native(p);
}

/** Allowed dirs that exist, with symlinks resolved. */
export function realAllowedDirs(dirs: string[]): string[] {
  const out: string[] = [];
  for (const d of dirs) {
    try {
      out.push(realpath(d));
    } catch {
      /* missing dir: nothing inside it can be reached */
    }
  }
  return out;
}

/**
 * Real path of `abs`: the deepest existing ancestor is resolved with realpath and the
 * not-yet-existing tail is appended. A dangling symlink on the way is refused (writing
 * through it would create a file wherever it points).
 */
export function resolveReal(abs: string): string {
  let cur = abs;
  const tail: string[] = [];
  while (true) {
    let exists = false;
    try {
      lstatSync(cur);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      let real: string;
      try {
        real = realpath(cur);
      } catch {
        throw new PathDenied(`The path ${abs} goes through a symbolic link to something that does not exist`);
      }
      return tail.length ? join(real, ...tail) : real;
    }
    const parent = dirname(cur);
    if (parent === cur) return abs;
    tail.unshift(basename(cur));
    cur = parent;
  }
}

export interface GuardOptions {
  /** Base for relative paths (default: the first allowed dir). */
  base?: string;
  /** Paths that are never reachable even if an allowed dir contains them (e.g. the daemon's own home). */
  deny?: string[];
}

/** Validates and resolves a path from the hub. Returns the real absolute path or throws PathDenied. */
export function resolveAllowedPath(input: unknown, allowedDirs: string[], opts: GuardOptions = {}): string {
  if (typeof input !== "string" || !input.trim()) throw new PathDenied("No path given");
  const raw = input.trim();
  if (raw.includes("\0")) throw new PathDenied("Invalid character in the path");
  const segments = raw.split(/[\\/]+/);
  if (segments.includes("..")) throw new PathDenied(`The path must not contain “..”: ${raw}`);
  if (WIN) {
    if (/^[\\/]{2}[?.][\\/]/.test(raw)) throw new PathDenied(`Windows device paths are not supported: ${raw}`);
    const rest = /^[a-zA-Z]:/.test(raw) ? raw.slice(2) : raw;
    if (rest.includes(":")) throw new PathDenied(`Invalid character “:” in the path: ${raw}`);
  }
  const real = realAllowedDirs(allowedDirs);
  if (!real.length) throw new PathDenied("This machine has no usable allowed folders (allowedDirs in policy.json)");
  let expanded = raw;
  if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) expanded = join(homedir(), raw.slice(1));
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(opts.base ?? real[0], expanded);
  const resolved = resolveReal(abs);
  for (const d of opts.deny ?? []) {
    let dr = d;
    try {
      dr = realpath(d);
    } catch {
      /* not created yet */
    }
    if (isInside(resolved, dr) || isInside(resolved, d)) throw new PathDenied(`The openbot-node state folder is off limits: ${raw}`);
  }
  if (!real.some((d) => isInside(resolved, d))) {
    throw new PathDenied(`The path ${raw} is outside the allowed folders (${allowedDirs.join(", ")})`);
  }
  return resolved;
}

/**
 * Workspace key from the hub ("assistant/c_123") → <root>/<key>, created if missing.
 * Absolute keys, "..", "." and odd characters are refused.
 */
export function resolveWorkspace(key: unknown, root: string): string {
  if (typeof key !== "string" || !key.trim()) throw new PathDenied("No session working folder given");
  const k = key.trim();
  if (isAbsolute(k) || /^[a-zA-Z]:/.test(k) || k.startsWith("/") || k.startsWith("\\")) {
    throw new PathDenied(`The working folder must be a relative key, got: ${k}`);
  }
  const parts = k.split("/");
  for (const s of parts) {
    if (!s || s === "." || s === ".." || /[\\:*?"<>|\x00-\x1f]/.test(s) || s.length > 128) throw new PathDenied(`Invalid working folder key: ${k}`);
  }
  mkdirSync(root, { recursive: true });
  const realRoot = realpath(root);
  const target = join(realRoot, ...parts);
  mkdirSync(target, { recursive: true });
  const realTarget = realpath(target);
  if (!isInside(realTarget, realRoot) || cmp(realTarget) === cmp(realRoot)) throw new PathDenied(`The working folder is outside ${root}: ${k}`);
  return realTarget;
}
