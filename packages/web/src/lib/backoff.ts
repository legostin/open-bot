/** Reconnect delay: exponential from `base` up to `max`, with up to 25% jitter. attempt starts at 0. */
export function backoffDelay(attempt: number, opts: { base?: number; max?: number; random?: () => number } = {}): number {
  const base = opts.base ?? 500;
  const max = opts.max ?? 30_000;
  const rnd = opts.random ?? Math.random;
  const exp = Math.min(max, base * 2 ** Math.max(0, Math.min(attempt, 20)));
  return Math.round(exp * (0.75 + rnd() * 0.25));
}
