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
  if (!policy.fs.read) throw new FsDenied("Чтение файлов на этой машине запрещено (fs.read = false в policy.json)");
  const p = resolveAllowedPath(params?.path, policy.allowedDirs, guard);
  let st;
  try {
    st = statSync(p);
  } catch {
    throw new FsDenied(`Файл не найден: ${String(params?.path)}`);
  }
  if (st.isDirectory()) throw new FsDenied(`Это папка, а не файл: ${String(params?.path)} (используйте список файлов)`);
  if (st.size > MAX_READ_BYTES) throw new FsDenied(`Файл слишком большой: ${(st.size / 1024 / 1024).toFixed(1)} МБ (максимум ${MAX_READ_BYTES / 1024 / 1024} МБ)`);
  const buf = readFileSync(p);
  if (buf.subarray(0, 8192).includes(0)) throw new FsDenied(`Двоичный файл, прочитать как текст нельзя: ${String(params?.path)}`);
  return { content: buf.toString("utf8") };
}

export function fsWrite(params: { path?: unknown; content?: unknown }, policy: Policy, guard: GuardOptions): { bytes: number } {
  if (!policy.fs.write) throw new FsDenied("Запись файлов на этой машине запрещена (fs.write = false в policy.json)");
  if (typeof params?.content !== "string") throw new FsDenied("content: ожидается строка");
  const bytes = Buffer.byteLength(params.content, "utf8");
  if (bytes > MAX_WRITE_BYTES) throw new FsDenied(`Слишком большой файл: максимум ${MAX_WRITE_BYTES / 1024 / 1024} МБ`);
  const p = resolveAllowedPath(params?.path, policy.allowedDirs, guard);
  try {
    if (statSync(p).isDirectory()) throw new FsDenied(`Это папка, а не файл: ${String(params?.path)}`);
  } catch (e) {
    if (e instanceof FsDenied) throw e;
  }
  const parent = dirname(p);
  mkdirSync(parent, { recursive: true });
  // The parent chain might have been swapped for a symlink between the check and mkdir: verify again.
  const realParent = realpathSync.native(parent);
  if (!realAllowedDirs(policy.allowedDirs).some((d) => isInside(realParent, d))) throw new PathDenied(`Путь ${String(params?.path)} вне разрешённых папок`);
  writeFileSync(p, params.content, "utf8");
  return { bytes };
}

export function fsList(params: { path?: unknown }, policy: Policy, guard: GuardOptions): { entries: ListEntry[]; truncated?: boolean } {
  if (!policy.fs.read) throw new FsDenied("Чтение файлов на этой машине запрещено (fs.read = false в policy.json)");
  const p = resolveAllowedPath(params?.path ?? ".", policy.allowedDirs, guard);
  let dirents;
  try {
    dirents = readdirSync(p, { withFileTypes: true });
  } catch (e: any) {
    if (e?.code === "ENOENT") throw new FsDenied(`Папка не найдена: ${String(params?.path)}`);
    if (e?.code === "ENOTDIR") throw new FsDenied(`Это файл, а не папка: ${String(params?.path)}`);
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
