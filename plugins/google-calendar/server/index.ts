// Builtin plugin "google-calendar": the user's Google calendars for the agent. Reading (events, free time) is free;
// creating, changing and deleting events are external actions behind the approval card. The access token comes
// from the hub's Google connection (connections.token). The morning digest gets the day's events (digest.compose).

import type { PluginContext, PluginModule } from "@owlbot/plugin-sdk";
import type { ToolResult } from "@owlbot/shared";
import { addDays, dayStart, parseWhen, rfc3339, span, today, clock, type GTime, type When } from "./time.ts";

interface Settings {
  digest?: boolean;
  apiBaseUrl?: string;
}

interface GEvent {
  id: string;
  summary?: string;
  location?: string;
  description?: string;
  status?: string;
  htmlLink?: string;
  start: GTime;
  end: GTime;
  attendees?: Array<{ email: string; responseStatus?: string; self?: boolean }>;
  organizer?: { email?: string; self?: boolean };
  /** Added here: which calendar it came from. */
  calendar?: string;
}

interface GCalendar {
  id: string;
  summary: string;
  primary?: boolean;
  selected?: boolean;
  accessRole?: string;
  timeZone?: string;
}

const NOT_CONNECTED =
  "Google Calendar is not connected. Call hub_integration_connect with id google-calendar to show the user the Connect card, then try again once you get the system note.";
const MAX_EVENTS = 100;

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

class CalendarError extends Error {}

const plugin: PluginModule = {
  activate(ctx: PluginContext) {
    let settings: Settings = ctx.settings ?? {};
    ctx.onSettingsChange((s) => (settings = s ?? {}));
    const base = () => (settings.apiBaseUrl || "https://www.googleapis.com/calendar/v3").replace(/\/+$/, "");
    const timezone = async () => (await ctx.core.call<{ timezone?: string }>("settings.get").catch(() => ({ timezone: undefined }))).timezone || "UTC";

    /** One Calendar API call with the hub's token; Google's errors become CalendarError with its message. */
    async function api<T>(method: string, path: string, opts: { query?: Record<string, string | undefined>; body?: unknown } = {}): Promise<T> {
      let token: string;
      try {
        token = (await ctx.core.call<{ accessToken: string }>("connections.token", { provider: "google" })).accessToken;
      } catch (e: any) {
        const why = String(e?.message ?? e);
        throw new CalendarError(/not connected/i.test(why) ? NOT_CONNECTED : `Google Calendar: ${why}`);
      }
      const url = new URL(base() + path);
      for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(opts.body ? { "content-type": "application/json" } : {}) },
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e: any) {
        throw new CalendarError(`Google Calendar is unreachable (${e?.cause?.code ?? e?.name ?? "network error"})`);
      }
      if (res.status === 204) return undefined as T;
      const body = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new CalendarError(`Google Calendar: ${body?.error?.message ?? `HTTP ${res.status}`}`);
      return body as T;
    }

    async function calendars(): Promise<GCalendar[]> {
      const r = await api<{ items?: GCalendar[] }>("GET", "/users/me/calendarList", { query: { maxResults: "250" } });
      return r.items ?? [];
    }

    /** Events between two instants, from the given calendar or every calendar the user shows in Google. */
    async function events(from: number, to: number, tz: string, opts: { calendar?: string; query?: string; max?: number } = {}): Promise<GEvent[]> {
      const ids = opts.calendar ? [opts.calendar] : (await calendars()).filter((c) => c.selected || c.primary).map((c) => c.id);
      const all: GEvent[] = [];
      for (const id of ids.length ? ids : ["primary"]) {
        const r = await api<{ items?: GEvent[] }>("GET", `/calendars/${encodeURIComponent(id)}/events`, {
          query: { timeMin: rfc3339(from, tz), timeMax: rfc3339(to, tz), singleEvents: "true", orderBy: "startTime", timeZone: tz, q: opts.query, maxResults: String(opts.max ?? MAX_EVENTS) },
        });
        for (const e of r.items ?? []) if (e.status !== "cancelled") all.push({ ...e, calendar: id });
      }
      const key = (e: GEvent) => (e.start.date ? dayStart(e.start.date, tz) : Date.parse(e.start.dateTime ?? ""));
      return all.sort((a, b) => key(a) - key(b)).slice(0, opts.max ?? MAX_EVENTS);
    }

    const line = (e: GEvent, tz: string, showCalendar: boolean) =>
      [
        `- ${span(e.start, e.end, tz)}: ${e.summary || "(no title)"}`,
        e.location ? ` @ ${e.location}` : "",
        e.attendees?.length ? ` (with ${e.attendees.filter((a) => !a.self).map((a) => a.email).join(", ")})` : "",
        showCalendar && e.calendar && e.calendar !== "primary" ? ` [calendar ${e.calendar}]` : "",
        ` [id ${e.id}]`,
      ].join("");

    /** A period from the tool's input: `from` (default today) to `to` (default: the end of the day `from` starts). */
    function period(input: { from?: unknown; to?: unknown }, tz: string): { from: number; to: number } | string {
      const f: When = input.from === undefined ? { date: today(tz) } : (parseWhen(input.from, tz) ?? ({} as When));
      if (!("date" in f) && !("at" in f)) return `from: give a date YYYY-MM-DD or a local time YYYY-MM-DDTHH:MM`;
      const start = "date" in f ? dayStart(f.date, tz) : f.at;
      let end: number;
      if (input.to === undefined) end = "date" in f ? dayStart(addDays(f.date, 1), tz) : dayStart(addDays(today(tz, f.at), 1), tz);
      else {
        const t = parseWhen(input.to, tz);
        if (!t) return `to: give a date YYYY-MM-DD or a local time YYYY-MM-DDTHH:MM`;
        // A date as the end means "through that day".
        end = "date" in t ? dayStart(addDays(t.date, 1), tz) : t.at;
      }
      if (end <= start) return "to must be after from";
      if (end - start > 92 * 86_400_000) return "ask for at most three months at a time";
      return { from: start, to: end };
    }

    /** Google's start/end for an event from the tool's input; all-day when given dates. */
    function times(input: { start?: unknown; end?: unknown }, tz: string, required: boolean): { start?: GTime & { timeZone?: string }; end?: GTime & { timeZone?: string } } | string {
      if (input.start === undefined && input.end === undefined && !required) return {};
      const s = parseWhen(input.start, tz);
      if (!s) return "start: give a date YYYY-MM-DD (all day) or a local time YYYY-MM-DDTHH:MM";
      const e = input.end === undefined ? undefined : parseWhen(input.end, tz);
      if (input.end !== undefined && !e) return "end: give a date YYYY-MM-DD or a local time YYYY-MM-DDTHH:MM";
      if ("date" in s) {
        // Google's all-day end is exclusive: the day after the last one.
        const last = e && "date" in e ? e.date : s.date;
        return { start: { date: s.date }, end: { date: addDays(last, 1) } };
      }
      const endAt = e && "at" in e ? e.at : s.at + 3600_000;
      if (endAt <= s.at) return "end must be after start";
      return { start: { dateTime: rfc3339(s.at, tz), timeZone: tz }, end: { dateTime: rfc3339(endAt, tz), timeZone: tz } };
    }

    const run = (fn: (tz: string) => Promise<ToolResult>) => async (): Promise<ToolResult> => {
      try {
        return await fn(await timezone());
      } catch (e: any) {
        return text(e instanceof CalendarError ? e.message : `Google Calendar: ${e?.message ?? e}`, true);
      }
    };

    const whenHelp = "Dates as YYYY-MM-DD, times as local YYYY-MM-DDTHH:MM in the user's timezone.";

    ctx.tools.register({
      name: "calendars",
      description: "The user's Google calendars: id, name, which is primary, and whether events can be added to it.",
      effect: "read",
      inputSchema: { type: "object", properties: {} },
      handler: () =>
        run(async () => {
          const list = await calendars();
          return text(list.map((c) => `- ${c.summary}${c.primary ? " (primary)" : ""}: id ${c.id}, ${c.accessRole === "owner" || c.accessRole === "writer" ? "can add events" : "read only"}${c.selected ? "" : ", hidden in Google"}`).join("\n") || "No calendars.");
        })(),
    });

    ctx.tools.register({
      name: "events",
      description:
        `Events in the user's Google calendars: "what's on tomorrow", "when is my dentist", the week ahead. Without from/to: today. ${whenHelp} ` +
        "A date as `to` means through that day. Searches every calendar the user shows unless `calendar` is given; `query` matches the text of events.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "Start: YYYY-MM-DD or YYYY-MM-DDTHH:MM (default today)" },
          to: { type: "string", description: "End: YYYY-MM-DD (through that day) or YYYY-MM-DDTHH:MM" },
          calendar: { type: "string", description: "A calendar id (default: all shown calendars)" },
          query: { type: "string", description: "Words to look for" },
        },
      },
      handler: (i: any) =>
        run(async (tz) => {
          const p = period(i, tz);
          if (typeof p === "string") return text(p, true);
          const list = await events(p.from, p.to, tz, { calendar: i.calendar, query: i.query });
          const head = `Events ${rfc3339(p.from, tz)} – ${rfc3339(p.to, tz)} (${tz}):`;
          return text(list.length ? [head, ...list.map((e) => line(e, tz, true))].join("\n") : `${head} none.`);
        })(),
    });

    ctx.tools.register({
      name: "free_busy",
      description: `When the user is busy in a period, to find a free slot. ${whenHelp}`,
      effect: "read",
      inputSchema: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" }, calendars: { type: "array", items: { type: "string" }, description: "Calendar ids (default: all shown)" } },
        required: ["from"],
      },
      handler: (i: any) =>
        run(async (tz) => {
          const p = period(i, tz);
          if (typeof p === "string") return text(p, true);
          const ids: string[] = Array.isArray(i.calendars) && i.calendars.length ? i.calendars : (await calendars()).filter((c) => c.selected || c.primary).map((c) => c.id);
          const r = await api<{ calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }> }>("POST", "/freeBusy", {
            body: { timeMin: rfc3339(p.from, tz), timeMax: rfc3339(p.to, tz), timeZone: tz, items: ids.map((id) => ({ id })) },
          });
          const busy = Object.values(r.calendars ?? {})
            .flatMap((c) => c.busy ?? [])
            .map((b) => [Date.parse(b.start), Date.parse(b.end)] as const)
            .sort((a, b) => a[0] - b[0]);
          // Overlapping intervals from several calendars become one.
          const merged: Array<[number, number]> = [];
          for (const [a, b] of busy) {
            const last = merged.at(-1);
            if (last && a <= last[1]) last[1] = Math.max(last[1], b);
            else merged.push([a, b]);
          }
          if (!merged.length) return text(`Free the whole time from ${rfc3339(p.from, tz)} to ${rfc3339(p.to, tz)}.`);
          return text(["Busy:", ...merged.map(([a, b]) => `- ${span({ dateTime: new Date(a).toISOString() }, { dateTime: new Date(b).toISOString() }, tz)}`)].join("\n"));
        })(),
    });

    ctx.tools.register({
      name: "create_event",
      description:
        `Add an event to the user's Google calendar (the user approves it first). ${whenHelp} A date as start makes an all-day event; ` +
        "without end a timed event lasts an hour. Attendees get Google's invitations.",
      effect: "external",
      approvalSummary: "%approval.create%",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          start: { type: "string", description: "YYYY-MM-DD (all day) or YYYY-MM-DDTHH:MM" },
          end: { type: "string", description: "YYYY-MM-DD (last day) or YYYY-MM-DDTHH:MM" },
          location: { type: "string" },
          description: { type: "string" },
          attendees: { type: "array", items: { type: "string" }, description: "Email addresses to invite" },
          calendar: { type: "string", description: "Calendar id (default: primary)" },
        },
        required: ["title", "start"],
      },
      handler: (i: any) =>
        run(async (tz) => {
          if (typeof i.title !== "string" || !i.title.trim()) return text("title is required", true);
          const t = times(i, tz, true);
          if (typeof t === "string") return text(t, true);
          const attendees = Array.isArray(i.attendees) ? i.attendees.filter((a: unknown) => typeof a === "string" && a.includes("@")).map((email: string) => ({ email })) : [];
          const e = await api<GEvent>("POST", `/calendars/${encodeURIComponent(i.calendar || "primary")}/events`, {
            query: { sendUpdates: attendees.length ? "all" : "none" },
            body: { summary: i.title.trim(), location: i.location, description: i.description, ...t, ...(attendees.length ? { attendees } : {}) },
          });
          return text(`Created: ${span(e.start, e.end, tz)}: ${e.summary} [id ${e.id}]${e.htmlLink ? ` ${e.htmlLink}` : ""}`);
        })(),
    });

    ctx.tools.register({
      name: "update_event",
      description: `Change an event (the user approves it first): give its id (from calendar_events) and only the fields to change. ${whenHelp}`,
      effect: "external",
      approvalSummary: "%approval.update%",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          calendar: { type: "string" },
          title: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
          location: { type: "string" },
          description: { type: "string" },
        },
        required: ["id"],
      },
      handler: (i: any) =>
        run(async (tz) => {
          const t = times(i, tz, false);
          if (typeof t === "string") return text(t, true);
          const patch: Record<string, unknown> = { ...t };
          if (typeof i.title === "string") patch.summary = i.title;
          if (typeof i.location === "string") patch.location = i.location;
          if (typeof i.description === "string") patch.description = i.description;
          if (!Object.keys(patch).length) return text("Nothing to change: give title, start, end, location or description.", true);
          const e = await api<GEvent>("PATCH", `/calendars/${encodeURIComponent(i.calendar || "primary")}/events/${encodeURIComponent(i.id)}`, { query: { sendUpdates: "all" }, body: patch });
          return text(`Changed: ${span(e.start, e.end, tz)}: ${e.summary} [id ${e.id}]`);
        })(),
    });

    ctx.tools.register({
      name: "delete_event",
      description: "Delete an event (the user approves it first): its id from calendar_events.",
      effect: "external",
      approvalSummary: "%approval.delete%",
      inputSchema: { type: "object", properties: { id: { type: "string" }, calendar: { type: "string" } }, required: ["id"] },
      handler: (i: any) =>
        run(async () => {
          await api("DELETE", `/calendars/${encodeURIComponent(i.calendar || "primary")}/events/${encodeURIComponent(i.id)}`, { query: { sendUpdates: "all" } });
          return text(`Deleted the event ${i.id}.`);
        })(),
    });

    // The digest: this morning's plan, or tomorrow's in a later digest. Nothing when there is nothing or no connection.
    ctx.hooks.on("digest.compose", async (p) => {
      if (settings.digest === false) return;
      const tz = p.timezone || (await timezone());
      const date = p.time < "12:00" ? p.date : addDays(p.date, 1);
      try {
        const list = await events(dayStart(date, tz), dayStart(addDays(date, 1), tz), tz);
        if (!list.length) return;
        const lines = list.map((e) => `${e.start.date ? ctx.i18n.t("digest.allDay") : `${clock(Date.parse(e.start.dateTime!), tz)}–${clock(Date.parse(e.end.dateTime ?? e.start.dateTime!), tz)}`} ${e.summary || "—"}${e.location ? `, ${e.location}` : ""}`);
        return { title: ctx.i18n.t(date === p.date ? "digest.today" : "digest.tomorrow"), body: lines.join("\n") };
      } catch (e: any) {
        ctx.log.info(`no calendar section in the digest: ${e?.message ?? e}`);
        return;
      }
    });
  },
};

export default plugin;
