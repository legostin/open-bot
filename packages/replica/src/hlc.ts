// Hybrid logical clock: wall time in ms plus a counter, written so that string order is time order
// ("2026-10-30T12:00:00.000Z-000000"). Every replica stamps its changes with it; last writer wins by it.

const COUNTER = 6;
const MAX_COUNTER = 10 ** COUNTER - 1;
const FORMAT = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)-(\d{6})$/;

export interface HlcTime {
  ms: number;
  counter: number;
}

export function formatHlc(t: HlcTime): string {
  return `${new Date(t.ms).toISOString()}-${String(t.counter).padStart(COUNTER, "0")}`;
}

/** The time in a clock string, or null for anything that is not one. */
export function parseHlc(s: unknown): HlcTime | null {
  if (typeof s !== "string") return null;
  const m = FORMAT.exec(s);
  if (!m) return null;
  const ms = Date.parse(m[1]);
  return Number.isFinite(ms) ? { ms, counter: Number(m[2]) } : null;
}

export class Hlc {
  private readonly clock: () => number;
  private ms = 0;
  private counter = 0;

  constructor(now: () => number = Date.now) {
    this.clock = now;
  }

  /** A time later than every time this clock has given or seen. */
  now(): string {
    const wall = Math.floor(this.clock());
    if (wall > this.ms) {
      this.ms = wall;
      this.counter = 0;
    } else if (this.counter < MAX_COUNTER) {
      this.counter++;
    } else {
      // A million stamps in one millisecond: borrow the next one.
      this.ms++;
      this.counter = 0;
    }
    return formatHlc({ ms: this.ms, counter: this.counter });
  }

  /** A time from another replica: what this clock gives next comes after it. */
  observe(remote: string): void {
    const t = parseHlc(remote);
    if (!t) return;
    if (t.ms > this.ms || (t.ms === this.ms && t.counter > this.counter)) {
      this.ms = t.ms;
      this.counter = t.counter;
    }
  }
}
