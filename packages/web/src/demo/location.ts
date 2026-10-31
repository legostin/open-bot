// The app's address inside the demo: in memory (the frame's own URL never changes), readable and settable by the
// director, and given to wouter as its location and search hooks.

import { useSyncExternalStore } from "react";

export function demoLocation(initial: string) {
  let [path, search] = split(initial);
  const subs = new Set<() => void>();
  const subscribe = (cb: () => void) => {
    subs.add(cb);
    return () => void subs.delete(cb);
  };
  const navigate = (to: string | URL) => {
    [path, search] = split(String(to));
    for (const cb of subs) cb();
  };
  return {
    hook: (): [string, typeof navigate] => [useSyncExternalStore(subscribe, () => path), navigate],
    searchHook: (): string => useSyncExternalStore(subscribe, () => search),
    navigate,
    path: () => path,
  };
}

function split(to: string): [string, string] {
  const i = to.indexOf("?");
  return i < 0 ? [to || "/", ""] : [to.slice(0, i) || "/", to.slice(i + 1)];
}
