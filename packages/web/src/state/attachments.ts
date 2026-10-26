// Files waiting in a conversation's composer: picked, pasted or dropped on the chat. Each uploads at once
// (POST /api/conversations/:id/attachments); the message then names the uploaded paths.

import { errorText, upload } from "../lib/api";
import { admit, isImage, type PendingFile, type Rejection } from "../lib/attachments";
import { createStore, useStore } from "../lib/store";
import { t } from "../i18n";
import { toast } from "./toast";

const pending = createStore<Record<string, PendingFile[]>>({});
const NONE: PendingFile[] = [];
let seq = 0;

export function usePendingFiles(conversationId: string): PendingFile[] {
  return useStore(pending)[conversationId] ?? NONE;
}

function update(conversationId: string, fn: (list: PendingFile[]) => PendingFile[]): void {
  pending.set((all) => ({ ...all, [conversationId]: fn(all[conversationId] ?? NONE) }));
}

function rejectionText(r: Rejection): string {
  if (r.reason === "tooLarge") return t("composer.fileTooLarge", { name: r.name });
  if (r.reason === "empty") return t("composer.fileEmpty", { name: r.name });
  return t("composer.tooManyFiles");
}

export function addFiles(conversationId: string, files: File[]): void {
  const { accepted, rejected } = admit(pending.get()[conversationId] ?? NONE, files);
  // One toast per kind of refusal is enough.
  for (const r of rejected.filter((r, i) => rejected.findIndex((x) => x.reason === r.reason) === i)) toast(rejectionText(r), "error");
  for (const f of accepted) {
    const id = `file${++seq}`;
    const name = f.name || t("composer.pastedFile");
    update(conversationId, (list) => [
      ...list,
      { id, name, size: f.size, type: f.type, status: "uploading", preview: isImage(f.type) ? URL.createObjectURL(f) : undefined },
    ]);
    const query = `name=${encodeURIComponent(name)}${f.type ? `&type=${encodeURIComponent(f.type)}` : ""}`;
    upload<{ path: string }>(`/api/conversations/${encodeURIComponent(conversationId)}/attachments?${query}`, f).then(
      (part) => update(conversationId, (list) => list.map((p) => (p.id === id ? { ...p, status: "ready", path: part.path } : p))),
      (e) => update(conversationId, (list) => list.map((p) => (p.id === id ? { ...p, status: "error", error: errorText(e) } : p))),
    );
  }
}

/** Takes files out of the composer (removed by the user, or sent). */
export function removeFiles(conversationId: string, ids: string[]): void {
  update(conversationId, (list) =>
    list.filter((p) => {
      if (!ids.includes(p.id)) return true;
      if (p.preview) URL.revokeObjectURL(p.preview);
      return false;
    }),
  );
}
