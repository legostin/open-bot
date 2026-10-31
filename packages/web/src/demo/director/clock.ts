// Time in a chapter: every wait scales with the speed (the site's checks play at ×8) and ends early when the chapter is
// stopped, so a script never outlives its chapter.

export class Stopped extends Error {
  constructor() {
    super("chapter stopped");
  }
}

export class Clock {
  speed: number;
  readonly signal: AbortSignal;
  private paused = false;
  private resumeWaiters: Array<() => void> = [];

  constructor(signal: AbortSignal, speed = 1) {
    this.signal = signal;
    this.speed = speed;
  }

  check(): void {
    if (this.signal.aborted) throw new Stopped();
  }

  /** `ms` at speed 1. */
  async wait(ms: number): Promise<void> {
    this.check();
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, Math.max(0, ms / this.speed));
      this.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new Stopped());
        },
        { once: true },
      );
    });
    while (this.paused) await new Promise<void>((r) => this.resumeWaiters.push(r));
    this.check();
  }

  /** A promise that also ends when the chapter stops. */
  until<T>(p: Promise<T>): Promise<T> {
    this.check();
    return new Promise<T>((resolve, reject) => {
      this.signal.addEventListener("abort", () => reject(new Stopped()), { once: true });
      p.then(resolve, reject);
    });
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    for (const r of this.resumeWaiters.splice(0)) r();
  }
}
