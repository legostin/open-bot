// The current time for the model. The system prompt states the time a brain session opened, and an agent's dialog
// keeps its session for days: turns carry a fresh `[Now: …]` line so "in two hours" means from now.

/** How long a session goes without a new time line. */
const EVERY_MS = 10 * 60_000;

/** `[Now: Tuesday, 27 October 2026, 09:15 (Asia/Almaty)]` in the user's timezone. */
export function nowLine(timezone: string, at = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `[Now: ${get("weekday")}, ${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")} (${timezone})]`;
}

/** Decides per brain session when its next turn needs the time again. */
export class TurnClock {
  private last = new Map<string, number>();

  /** The time line for this session's turn, or undefined when it had one less than ten minutes ago. */
  line(sessionId: string, timezone: string, at = new Date()): string | undefined {
    const prev = this.last.get(sessionId);
    if (prev !== undefined && at.getTime() - prev < EVERY_MS) return undefined;
    this.last.set(sessionId, at.getTime());
    return nowLine(timezone, at);
  }

  forget(sessionId: string): void {
    this.last.delete(sessionId);
  }
}
