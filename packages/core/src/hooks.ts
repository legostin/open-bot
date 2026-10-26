// Hook registry: plugins (and core modules) can intercept lifecycle points.
// Hooks may block or modify; they never turn a policy "ask"/"deny" into "allow" (policy runs after hooks).

export type HookName = "session.start" | "tool.before" | "tool.after" | "message.in" | "notify.before";

interface HookEntry {
  owner: string;
  run: (payload: unknown) => Promise<any>;
}

export class HookRegistry {
  private hooks = new Map<HookName, HookEntry[]>();

  register(hook: HookName, owner: string, run: (payload: unknown) => Promise<any>): void {
    const list = this.hooks.get(hook) ?? [];
    list.push({ owner, run });
    this.hooks.set(hook, list);
  }

  unregisterOwner(owner: string): void {
    for (const [k, list] of this.hooks) this.hooks.set(k, list.filter((e) => e.owner !== owner));
  }

  /** Run all handlers in registration order; each sees the previous handler's modifications. */
  async run<T extends Record<string, any>>(hook: HookName, payload: T, merge: (payload: T, result: any) => T | { blocked: string }): Promise<{ payload: T; blocked?: string; results: any[] }> {
    let cur = payload;
    const results: any[] = [];
    for (const e of this.hooks.get(hook) ?? []) {
      let r: any;
      try {
        r = await withTimeout(e.run(cur), 10_000);
      } catch (err) {
        console.error(`[hooks] ${hook} handler from ${e.owner} failed:`, (err as Error).message);
        continue;
      }
      if (r === null || r === undefined) continue;
      results.push(r);
      const next = merge(cur, r);
      if ("blocked" in next && typeof (next as any).blocked === "string" && Object.keys(next).length === 1) {
        return { payload: cur, blocked: `${(next as any).blocked} (хук ${e.owner})`, results };
      }
      cur = next as T;
    }
    return { payload: cur, results };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("hook timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
