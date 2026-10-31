// Files waiting in a conversation's composer: picked, pasted or dropped on the chat. Each uploads at once
// (POST /api/conversations/:id/attachments) with its progress shown; the message then names the uploaded paths.
// A file taken out before sending is cancelled or deleted on the hub; a picture marked up in the viewer replaces its
// upload, and keeps its original and marks so it can be marked again.

import { api, errorText, upload } from "../lib/api";
import { admit, isImage, type PendingFile, type Rejection } from "../lib/attachments";
import type { Shape } from "../lib/markup";
import { createStore, useStore } from "../lib/store";
import { t } from "../i18n";
import { toast } from "./toast";

const pending = createStore<Record<string, PendingFile[]>>({});
const NONE: PendingFile[] = [];
let seq = 0;

/** What a pending file's upload needs and what the page keeps beside the store: the bytes, the request, the original. */
interface Local {
  blob: Blob;
  controller?: AbortController;
  /** Before it was marked up: the picture as picked, and the marks on it. */
  markup?: { source: Blob; shapes: Shape[] };
}
const local = new Map<string, Local>();

export function usePendingFiles(conversationId: string): PendingFile[] {
  return useStore(pending)[conversationId] ?? NONE;
}

export function pendingFiles(conversationId: string): PendingFile[] {
  return pending.get()[conversationId] ?? NONE;
}

export const pendingStore = pending;

function update(conversationId: string, fn: (list: PendingFile[]) => PendingFile[]): void {
  pending.set((all) => ({ ...all, [conversationId]: fn(all[conversationId] ?? NONE) }));
}

function patch(conversationId: string, id: string, p: Partial<PendingFile>): void {
  update(conversationId, (list) => list.map((f) => (f.id === id ? { ...f, ...p } : f)));
}

function rejectionText(r: Rejection): string {
  if (r.reason === "tooLarge") return t("composer.fileTooLarge", { name: r.name });
  if (r.reason === "empty") return t("composer.fileEmpty", { name: r.name });
  return t("composer.tooManyFiles");
}

const discardOnHub = (conversationId: string, path: string): Promise<void> =>
  api.del(`/api/conversations/${encodeURIComponent(conversationId)}/attachments?path=${encodeURIComponent(path)}`).then(
    () => {},
    () => {},
  );

/** Sends the file's current bytes; its progress goes into the store a few times a second at most. */
function start(conversationId: string, id: string): void {
  const l = local.get(id);
  const f = pendingFiles(conversationId).find((x) => x.id === id);
  if (!l || !f) return;
  l.controller?.abort();
  const controller = new AbortController();
  l.controller = controller;
  patch(conversationId, id, { status: "uploading", progress: 0, error: undefined, path: undefined });
  let shown = 0;
  let last = 0;
  const query = `name=${encodeURIComponent(f.name)}${f.type ? `&type=${encodeURIComponent(f.type)}` : ""}`;
  upload<{ path: string }>(`/api/conversations/${encodeURIComponent(conversationId)}/attachments?${query}`, l.blob, {
    signal: controller.signal,
    onProgress: (p) => {
      const now = performance.now();
      if (p < 1 && p - shown < 0.01 && now - last < 120) return;
      shown = p;
      last = now;
      patch(conversationId, id, { progress: p });
    },
  }).then(
    (part) => {
      if (l.controller !== controller) return;
      l.controller = undefined;
      // Taken out while the hub was answering: the file is not wanted.
      if (!pendingFiles(conversationId).some((x) => x.id === id)) return void discardOnHub(conversationId, part.path);
      patch(conversationId, id, { status: "ready", progress: 1, path: part.path });
    },
    (e) => {
      if (controller.signal.aborted || l.controller !== controller) return;
      l.controller = undefined;
      patch(conversationId, id, { status: "error", error: errorText(e) });
    },
  );
}

export function addFiles(conversationId: string, files: File[]): void {
  const { accepted, rejected } = admit(pendingFiles(conversationId), files);
  // One toast per kind of refusal is enough.
  for (const r of rejected.filter((r, i) => rejected.findIndex((x) => x.reason === r.reason) === i)) toast(rejectionText(r), "error");
  for (const f of accepted) {
    const id = `file${++seq}`;
    const name = f.name || t("composer.pastedFile");
    local.set(id, { blob: f });
    update(conversationId, (list) => [
      ...list,
      { id, name, size: f.size, type: f.type, status: "uploading", progress: 0, preview: isImage(f.type) ? URL.createObjectURL(f) : undefined },
    ]);
    start(conversationId, id);
  }
}

/** A failed upload, once more. */
export function retryFile(conversationId: string, id: string): void {
  start(conversationId, id);
}

function forget(list: PendingFile[], ids: string[]): PendingFile[] {
  return list.filter((p) => {
    if (!ids.includes(p.id)) return true;
    if (p.preview) URL.revokeObjectURL(p.preview);
    local.get(p.id)?.controller?.abort();
    local.delete(p.id);
    return false;
  });
}

/** Takes sent files out of the composer (the message names them now). */
export function removeFiles(conversationId: string, ids: string[]): void {
  update(conversationId, (list) => forget(list, ids));
}

/** The person took files out before sending: an upload in flight stops, an uploaded one is deleted on the hub. */
export function discardFiles(conversationId: string, ids: string[]): void {
  const uploaded = pendingFiles(conversationId).flatMap((f) => (ids.includes(f.id) && f.path ? [f.path] : []));
  update(conversationId, (list) => forget(list, ids));
  for (const path of uploaded) void discardOnHub(conversationId, path);
}

/** The picture as picked and the marks on it, to mark it again; `marked`: the file in the composer is a marked copy. */
export function markupOf(id: string): { source: Blob; shapes: Shape[]; marked: boolean } | undefined {
  const l = local.get(id);
  if (!l) return undefined;
  return l.markup ? { ...l.markup, marked: true } : { source: l.blob, shapes: [], marked: false };
}

/**
 * The marked-up copy replaces the file: the old upload goes (so the copy keeps the name), the copy uploads.
 * No marks left: the original comes back.
 */
export function replaceWithMarked(conversationId: string, id: string, marked: { blob: Blob; name: string; type: string } | undefined, shapes: Shape[]): void {
  const l = local.get(id);
  const f = pendingFiles(conversationId).find((x) => x.id === id);
  if (!l || !f) return;
  const source = l.markup?.source ?? l.blob;
  const original = l.markup ? { name: l.markup.source instanceof File ? l.markup.source.name : f.name, type: source.type } : { name: f.name, type: f.type };
  l.controller?.abort();
  l.controller = undefined;
  if (f.preview) URL.revokeObjectURL(f.preview);
  const next = marked ?? { blob: source, ...original };
  l.blob = next.blob;
  l.markup = marked ? { source, shapes } : undefined;
  patch(conversationId, id, {
    name: next.name,
    type: next.type,
    size: next.blob.size,
    preview: URL.createObjectURL(next.blob),
    marked: !!marked,
    status: "uploading",
    progress: 0,
    error: undefined,
    path: undefined,
  });
  // The old upload is gone before the copy arrives, so the copy keeps the name.
  void (f.path ? discardOnHub(conversationId, f.path) : Promise.resolve()).then(() => {
    if (local.get(id) === l && l.blob === next.blob) start(conversationId, id);
  });
}
