// Access from anywhere (GET /api/remote): the card's steps and the link, refreshed when the hub reports a change.

import type { RemoteView } from "@piomio/shared";
import { api } from "../lib/api";
import { createStore, useStore } from "../lib/store";
import { hubEvents } from "./app";
import { loadIntegrations } from "./integrations";

export const remote = createStore<RemoteView | undefined>(undefined);
let loading: Promise<void> | undefined;
let wired = false;

export function loadRemote(): Promise<void> {
  loading ??= api
    .get<RemoteView>("/api/remote")
    .then((v) => remote.set(v))
    .finally(() => (loading = undefined));
  return loading;
}

/** Sets what an action returned and refreshes the library's card with it. */
export function setRemote(v: RemoteView): void {
  remote.set(v);
  void loadIntegrations().catch(() => {});
}

export function useRemote(): RemoteView | undefined {
  if (!wired) {
    wired = true;
    hubEvents.on((e) => {
      if (e.type === "remote.updated") {
        void loadRemote().catch(() => {});
        void loadIntegrations().catch(() => {});
      }
    });
  }
  const v = useStore(remote);
  if (v === undefined && !loading) void loadRemote().catch(() => {});
  return v;
}
