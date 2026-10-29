// The desktop app signs its own window in: it hands the hub one-time tickets over the hub's stdin, a pipe only the
// app that started the hub holds (OWLBOT_DESKTOP=1). The window then posts its ticket to POST /api/auth/desktop.

import { createHash, timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

const TICKET_TTL_MS = 60_000;
const hash = (ticket: string) => createHash("sha256").update(ticket).digest("hex");

/** One-time sign-in tickets, in memory only: a restart forgets them. */
export class DesktopTickets {
  private tickets = new Map<string, number>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  add(ticket: string): void {
    if (!/^[\w-]{32,128}$/.test(ticket)) return;
    const now = this.now();
    for (const [h, expires] of this.tickets) if (expires <= now) this.tickets.delete(h);
    this.tickets.set(hash(ticket), now + TICKET_TTL_MS);
  }

  /** True once per ticket, while it is fresh. */
  consume(ticket: string): boolean {
    const h = hash(ticket);
    const expires = this.tickets.get(h);
    this.tickets.delete(h);
    return expires !== undefined && expires > this.now();
  }
}

/**
 * The app's own key for answering approval cards (server/main-app.ts, /api/desktop/approvals): the app asks the
 * person with Touch ID, showing what the card asks as the hub tells it, then answers with this key. The page in its
 * window never sees the key, so nothing running there (a plugin's code) can answer for the person.
 */
export class DesktopApprover {
  private key?: Buffer;

  set(key: string): void {
    if (/^[\w-]{32,128}$/.test(key)) this.key = createHash("sha256").update(key).digest();
  }

  get enabled(): boolean {
    return !!this.key;
  }

  check(key: string | undefined): boolean {
    if (!this.key || !key) return false;
    return timingSafeEqual(this.key, createHash("sha256").update(key).digest());
  }
}

/**
 * The app's lines on stdin: `stop` (Windows has no SIGTERM for a windowless child), `ticket <t>` and `approver <key>`.
 * The app closing the pipe (it quit or crashed) stops the hub too, so the hub never outlives it.
 */
export function readDesktopCommands(input: Readable, on: { stop: () => void; ticket: (t: string) => void; approver?: (key: string) => void }): void {
  const lines = createInterface({ input });
  lines.on("line", (line) => {
    const [cmd, arg] = line.trim().split(/\s+/, 2);
    if (cmd === "stop") on.stop();
    else if (cmd === "ticket" && arg) on.ticket(arg);
    else if (cmd === "approver" && arg) on.approver?.(arg);
  });
  lines.on("close", () => on.stop());
}
