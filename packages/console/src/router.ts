import { useSyncExternalStore } from "react";
import { parseRoute, type Route } from "./lib/route.ts";

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};
const snapshot = () => location.hash;

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, snapshot, snapshot);
  return parseRoute(hash);
}

export function navigate(hash: string): void {
  if (location.hash !== hash) location.hash = hash;
}
