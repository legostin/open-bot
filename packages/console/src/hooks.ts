import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText, SessionLostError } from "./api.ts";
import type { ToolInfo } from "./types.ts";

export interface AsyncState<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (fn: (prev: T | undefined) => T | undefined) => void;
}

/** Load data on mount; `reload` refetches without clearing what is shown. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setDataState] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const d = await fnRef.current();
      if (my === seq.current) {
        setDataState(d);
        setError(undefined);
      }
    } catch (e) {
      if (my === seq.current && !(e instanceof SessionLostError)) setError(errorText(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const setData = useCallback((f: (prev: T | undefined) => T | undefined) => setDataState((p) => f(p)), []);
  return { data, error, loading, reload, setData };
}

let toolsCache: Promise<ToolInfo[]> | undefined;

/** Tool catalogue for pickers; cached for the page lifetime, refetched on failure. */
export function useTools(): ToolInfo[] {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  useEffect(() => {
    toolsCache ??= api.tools().then((l) => l.sort((a, b) => a.name.localeCompare(b.name)));
    let alive = true;
    toolsCache.then((l) => alive && setTools(l)).catch(() => (toolsCache = undefined));
    return () => {
      alive = false;
    };
  }, []);
  return tools;
}

/** Re-render periodically so relative times stay fresh. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
