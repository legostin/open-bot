// The integrations library (GET /api/integrations), shared by the page and the cards in the chat; refreshed live.

import type { IntegrationView } from "@piomio/shared";
import { api } from "../lib/api";
import { createStore, useStore } from "../lib/store";
import { hubEvents } from "./app";

export const integrations = createStore<IntegrationView[] | undefined>(undefined);
let loading: Promise<void> | undefined;
let wired = false;

export function loadIntegrations(): Promise<void> {
  loading ??= api
    .get<IntegrationView[]>("/api/integrations")
    .then((list) => integrations.set(list))
    .finally(() => (loading = undefined));
  return loading;
}

/** The list, loaded on first use and kept fresh while the hub reports changes. */
export function useIntegrations(): IntegrationView[] | undefined {
  if (!wired) {
    wired = true;
    hubEvents.on((e) => {
      if (e.type === "connections.updated" || e.type === "plugins.updated" || e.type === "vault.state" || e.type === "plugin.event" || e.type === "remote.updated") void loadIntegrations().catch(() => {});
    });
  }
  const list = useStore(integrations);
  if (list === undefined && !loading) void loadIntegrations().catch(() => {});
  return list;
}
