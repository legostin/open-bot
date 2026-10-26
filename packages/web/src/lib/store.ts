// Minimal external store + React binding (useSyncExternalStore).

import { useSyncExternalStore } from "react";

export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(cb: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      const value = typeof next === "function" ? (next as (p: T) => T)(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      for (const cb of [...subs]) cb();
    },
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Simple typed event emitter. */
export class Emitter<E> {
  private subs = new Set<(e: E) => void>();
  on(cb: (e: E) => void): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }
  emit(e: E): void {
    for (const cb of [...this.subs]) {
      try {
        cb(e);
      } catch (err) {
        console.error("[openbot] event handler failed", err);
      }
    }
  }
}
