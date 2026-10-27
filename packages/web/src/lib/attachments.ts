// Files picked, pasted or dropped into the composer: the hub's limits, what can be sent, sizes for display.

/** The hub's limits (packages/core/src/attachments.ts). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 10;

export interface PendingFile {
  id: string;
  name: string;
  size: number;
  type: string;
  status: "uploading" | "ready" | "error";
  /** The hub's path once uploaded (sent with the message). */
  path?: string;
  error?: string;
  /** An object URL for a picture's thumbnail. */
  preview?: string;
}

export type Rejection = { name: string; reason: "tooLarge" | "tooMany" | "empty" };

/** Which new files fit next to the ones already waiting. */
export function admit<F extends { name: string; size: number }>(current: PendingFile[], files: F[]): { accepted: F[]; rejected: Rejection[] } {
  const accepted: F[] = [];
  const rejected: Rejection[] = [];
  let room = MAX_FILES - current.length;
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) rejected.push({ name: f.name, reason: "tooLarge" });
    else if (!f.size) rejected.push({ name: f.name, reason: "empty" });
    else if (room <= 0) rejected.push({ name: f.name, reason: "tooMany" });
    else {
      accepted.push(f);
      room--;
    }
  }
  return { accepted, rejected };
}

/** Words or an uploaded file, and nothing still uploading (a failed file is left behind). */
export function canSend(text: string, files: PendingFile[]): boolean {
  if (files.some((f) => f.status === "uploading")) return false;
  return !!text.trim() || files.some((f) => f.status === "ready");
}

export function readyPaths(files: PendingFile[]): string[] {
  return files.flatMap((f) => (f.status === "ready" && f.path ? [f.path] : []));
}

/** A picture the browser shows as a thumbnail (SVG stays a file: it is shown through the hub, sandboxed). */
export function isImage(type: string | undefined): boolean {
  return !!type && /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(type);
}

/** 512 B, 47 KB, 1.2 MB: the number and the unit's catalog suffix. */
export function sizeParts(bytes: number): { n: number; unit: "b" | "kb" | "mb" } {
  if (bytes < 1024) return { n: bytes, unit: "b" };
  if (bytes < 1024 * 1024) return { n: Math.round(bytes / 1024), unit: "kb" };
  const mb = bytes / (1024 * 1024);
  return { n: mb >= 10 ? Math.round(mb) : Number(mb.toFixed(1)), unit: "mb" };
}
