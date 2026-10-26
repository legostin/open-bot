// fs.read / fs.write / fs.list inside the allowed dirs.

import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Policy } from "./policy.ts";
import { PathDenied, realAllowedDirs, isInside, resolveAllowedPath, type GuardOptions } from "./guard.ts";

export const MAX_READ_BYTES = 5 * 1024 * 1024;
export const MAX_WRITE_BYTES = 10 * 1024 * 1024;
export const MAX_LIST_ENTRIES = 2000;

export class FsDenied extends Error {
  code = "FS_DENIED";
}

export interface ListEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
}

export function fsRead(params: { path?: unknown }, policy: Policy, guard: GuardOptions): { content: string } {
  if (!policy.fs.read) throw new FsDenied("Reading files is not allowed on this machine (fs.read = false in policy.json)");
  const p = resolveAllowedPath(params?.path, policy.allowedDirs, guard);
  let st;
  try {
    st = statSync(p);
  } catch {
    throw new FsDenied(`File not found: ${String(params?.path)}`);
  }
  if (st.isDirectory()) throw new FsDenied(`This is a folder, not a file: ${String(params?.path)} (list it instead)`);
  if (st.size > MAX_READ_BYTES) throw new FsDenied(`The file is too large: ${(st.size / 1024 / 1024).toFixed(1)} MB (at most ${MAX_READ_BYTES / 1024 / 1024} MB)`);
  const buf = readFileSync(p);
  if (buf.subarray(0, 8192).includes(0)) throw new FsDenied(`Binary file, cannot read it as text: ${String(params?.path)}`);
  return { content: buf.toString("utf8") };
}

export function fsWrite(params: { path?: unknown; content?: unknown }, policy: Policy, guard: GuardOptions): { bytes: number } {
  if (!policy.fs.write) throw new FsDenied("Writing files is not allowed on this machine (fs.write = false in policy.json)");
  if (typeof params?.content !== "string") throw new FsDenied("content: expected a string");
  const bytes = Buffer.byteLength(params.content, "utf8");
  if (bytes > MAX_WRITE_BYTES) throw new FsDenied(`The file is too large: at most ${MAX_WRITE_BYTES / 1024 / 1024} MB`);
  const p = resolveAllowedPath(params?.path, policy.allowedDirs, guard);
  try {
    if (statSync(p).isDirectory()) throw new FsDenied(`This is a folder, not a file: ${String(params?.path)}`);
  } catch (e) {
    if (e instanceof FsDenied) throw e;
  }
  const parent = dirname(p);
  mkdirSync(parent, { recursive: true });
  // The parent chain might have been swapped for a symlink between the check and mkdir: verify again.
  const realParent = realpathSync.native(parent);
  if (!realAllowedDirs(policy.allowedDirs).some((d) => isInside(realParent, d))) throw new PathDenied(`The path ${String(params?.path)} is outside the allowed folders`);
  writeFileSync(p, params.content, "utf8");
  return { bytes };
}

export function fsList(params: { path?: unknown }, policy: Policy, guard: GuardOptions): { entries: ListEntry[]; truncated?: boolean } {
  if (!policy.fs.read) throw new FsDenied("Reading files is not allowed on this machine (fs.read = false in policy.json)");
  const p = resolveAllowedPath(params?.path ?? ".", policy.allowedDirs, guard);
  let dirents;
  try {
    dirents = readdirSync(p, { withFileTypes: true });
  } catch (e: any) {
    if (e?.code === "ENOENT") throw new FsDenied(`Folder not found: ${String(params?.path)}`);
    if (e?.code === "ENOTDIR") throw new FsDenied(`This is a file, not a folder: ${String(params?.path)}`);
    throw e;
  }
  const entries: ListEntry[] = [];
  for (const d of dirents) {
    let type: "file" | "dir" = d.isDirectory() ? "dir" : "file";
    let size: number | undefined;
    try {
      if (d.isSymbolicLink() || d.isFile()) {
        const st = statSync(join(p, d.name));
        type = st.isDirectory() ? "dir" : "file";
        if (type === "file") size = st.size;
      }
    } catch {
      /* dangling link */
    }
    entries.push(size === undefined ? { name: d.name, type } : { name: d.name, type, size });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  if (entries.length > MAX_LIST_ENTRIES) return { entries: entries.slice(0, MAX_LIST_ENTRIES), truncated: true };
  return { entries };
}
