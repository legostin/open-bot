// The catalog (GET /api/catalog): everything the person can turn on, by situation; refreshed live like the
// integrations library, whose cards it shares.

import type { CatalogView } from "@owlbot/shared";
import { api } from "../lib/api";
import { createStore, useStore } from "../lib/store";
import { hubEvents } from "./app";

export const catalog = createStore<CatalogView | undefined>(undefined);
let loading: Promise<void> | undefined;
let wired = false;

export function loadCatalog(): Promise<void> {
  loading ??= api
    .get<CatalogView>("/api/catalog")
    .then((c) => catalog.set(c))
    .finally(() => (loading = undefined));
  return loading;
}

/** The catalog, loaded on first use and kept fresh while the hub reports changes. */
export function useCatalog(): CatalogView | undefined {
  if (!wired) {
    wired = true;
    hubEvents.on((e) => {
      if (e.type === "connections.updated" || e.type === "plugins.updated" || e.type === "vault.state" || e.type === "remote.updated") void loadCatalog().catch(() => {});
    });
  }
  const c = useStore(catalog);
  if (c === undefined && !loading) void loadCatalog().catch(() => {});
  return c;
}
