// Pages agents made (/api/pages), kept current by "page.updated" and "page.deleted".
import type { PageView, UiEvent } from "@piomio/shared";
import { api } from "../lib/api";
import { createStore } from "../lib/store";

export const pages = createStore<PageView[] | null>(null);

let loading: Promise<void> | undefined;

export function refreshPages(): Promise<void> {
  loading ??= (async () => {
    try {
      pages.set(await api.get<PageView[]>("/api/pages"));
    } catch {
      /* a hub from before pages: no cards */
      if (!pages.get()) pages.set([]);
    } finally {
      loading = undefined;
    }
  })();
  return loading;
}

export function ensurePages(): void {
  if (!pages.get() && !loading) void refreshPages();
}

export function clearPages(): void {
  pages.set(null);
}

export function onPageEvent(e: Extract<UiEvent, { type: "page.updated" | "page.deleted" }>): void {
  if (e.type === "page.deleted") return pages.set((list) => (list ? list.filter((p) => p.id !== e.data.id) : list));
  pages.set((list) => {
    if (!list) return list;
    const i = list.findIndex((p) => p.id === e.data.id);
    if (i < 0) return [e.data, ...list];
    const next = list.slice();
    next[i] = e.data;
    return next;
  });
}
