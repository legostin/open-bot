// The Google Calendar plugin against a fake Calendar API, with the hub's token and settings faked by the testkit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { startPlugin, type PluginHarness } from "@owlbot/testkit";

const dir = join(import.meta.dirname, "..");

interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  auth?: string;
  body?: any;
}

function fakeCalendar() {
  const requests: Req[] = [];
  const events: Record<string, any[]> = {
    primary: [
      { id: "e1", summary: "Standup", start: { dateTime: "2026-10-28T09:00:00+05:00" }, end: { dateTime: "2026-10-28T09:15:00+05:00" } },
      { id: "e2", summary: "Day off", start: { date: "2026-10-28" }, end: { date: "2026-10-29" } },
      { id: "gone", status: "cancelled", summary: "Cancelled", start: { dateTime: "2026-10-28T12:00:00+05:00" }, end: { dateTime: "2026-10-28T13:00:00+05:00" } },
    ],
    "family@group.calendar.google.com": [
      { id: "f1", summary: "Dinner with Olya", location: "Home", start: { dateTime: "2026-10-28T19:00:00+05:00" }, end: { dateTime: "2026-10-28T21:00:00+05:00" } },
    ],
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const u = new URL(req.url!, "http://x");
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      requests.push({ method: req.method!, path: decodeURIComponent(u.pathname), query: u.searchParams, auth: req.headers.authorization, body });
      const send = (status: number, v?: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(v === undefined ? "" : JSON.stringify(v));
      if (req.headers.authorization !== "Bearer at-good") return send(401, { error: { code: 401, message: "Invalid Credentials" } });
      const p = decodeURIComponent(u.pathname);
      if (p === "/users/me/calendarList")
        return send(200, {
          items: [
            { id: "primary", summary: "anna@example.com", primary: true, selected: true, accessRole: "owner" },
            { id: "family@group.calendar.google.com", summary: "Family", selected: true, accessRole: "writer" },
            { id: "holidays", summary: "Holidays", selected: false, accessRole: "reader" },
          ],
        });
      const list = /^\/calendars\/([^/]+)\/events$/.exec(p);
      if (list && req.method === "GET") return send(200, { items: events[list[1]] ?? [] });
      if (list && req.method === "POST") return send(200, { id: "new1", htmlLink: "https://calendar.google.com/x", ...body });
      const one = /^\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(p);
      if (one && req.method === "PATCH") return send(200, { id: one[2], summary: body.summary ?? "Standup", start: body.start ?? events.primary[0].start, end: body.end ?? events.primary[0].end });
      if (one && req.method === "DELETE") return one[2] === "missing" ? send(404, { error: { code: 404, message: "Not Found" } }) : send(204);
      if (p === "/freeBusy")
        return send(200, {
          calendars: {
            primary: { busy: [{ start: "2026-10-28T04:00:00Z", end: "2026-10-28T05:00:00Z" }] },
            "family@group.calendar.google.com": { busy: [{ start: "2026-10-28T04:30:00Z", end: "2026-10-28T06:00:00Z" }] },
          },
        });
      send(404, { error: { code: 404, message: `no ${p}` } });
    });
  });
  return { server, requests };
}

describe("google calendar plugin", () => {
  let cal: ReturnType<typeof fakeCalendar>;
  let h: PluginHarness;
  let token = "at-good";
  let connected = true;

  beforeAll(async () => {
    cal = fakeCalendar();
    await new Promise<void>((r) => cal.server.listen(0, "127.0.0.1", r));
    h = await startPlugin({
      dir,
      settings: { apiBaseUrl: `http://127.0.0.1:${(cal.server.address() as any).port}` },
      core: (method) => {
        if (method === "settings.get") return { timezone: "Asia/Almaty" };
        if (method === "connections.token") {
          if (!connected) throw new Error("Google is not connected");
          return { accessToken: token, expiresAt: new Date(Date.now() + 3600_000).toISOString(), account: "anna@example.com" };
        }
        return {};
      },
    });
  });

  afterAll(async () => {
    await h?.stop();
    cal?.server.close();
  });

  it("registers its tools and the digest hook", () => {
    expect([...h.tools.keys()].sort()).toEqual(["calendars", "create_event", "delete_event", "events", "free_busy", "update_event"]);
    expect(h.tools.get("create_event")).toMatchObject({ effect: "external", approvalSummary: "%approval.create%" });
    expect(h.tools.get("events")).toMatchObject({ effect: "read" });
    expect(h.hooks.has("digest.compose")).toBe(true);
  });

  it("lists events from every calendar the user shows, in their timezone, without cancelled ones", async () => {
    const out = await h.invokeText("events", { from: "2026-10-28" });
    expect(out).toBe(
      [
        "Events 2026-10-28T00:00:00+05:00 – 2026-10-29T00:00:00+05:00 (Asia/Almaty):",
        "- Wed 28 Oct, all day: Day off [id e2]",
        "- Wed 28 Oct 09:00–09:15: Standup [id e1]",
        "- Wed 28 Oct 19:00–21:00: Dinner with Olya @ Home [calendar family@group.calendar.google.com] [id f1]",
      ].join("\n"),
    );
    const listed = cal.requests.filter((r) => r.path.endsWith("/events") && r.method === "GET");
    expect(listed.map((r) => r.path)).toEqual(["/calendars/primary/events", "/calendars/family@group.calendar.google.com/events"]);
    expect(Object.fromEntries(listed[0].query)).toMatchObject({ timeMin: "2026-10-28T00:00:00+05:00", timeMax: "2026-10-29T00:00:00+05:00", singleEvents: "true", orderBy: "startTime", timeZone: "Asia/Almaty" });
    expect(listed[0].auth).toBe("Bearer at-good");
    expect(await h.invokeText("events", { from: "next week" })).toMatch(/^from: give a date/);
  });

  it("finds busy time across calendars, overlaps merged", async () => {
    expect(await h.invokeText("free_busy", { from: "2026-10-28" })).toBe("Busy:\n- Wed 28 Oct 09:00–11:00");
    expect(cal.requests.at(-1)!.body).toMatchObject({ timeZone: "Asia/Almaty", items: [{ id: "primary" }, { id: "family@group.calendar.google.com" }] });
  });

  it("creates timed and all-day events, invites attendees", async () => {
    expect(await h.invokeText("create_event", { title: "Dentist", start: "2026-10-29T10:00" })).toBe("Created: Thu 29 Oct 10:00–11:00: Dentist [id new1] https://calendar.google.com/x");
    expect(cal.requests.at(-1)!.body).toEqual({
      summary: "Dentist",
      start: { dateTime: "2026-10-29T10:00:00+05:00", timeZone: "Asia/Almaty" },
      end: { dateTime: "2026-10-29T11:00:00+05:00", timeZone: "Asia/Almaty" },
    });
    expect(cal.requests.at(-1)!.query.get("sendUpdates")).toBe("none");
    await h.invokeText("create_event", { title: "Trip", start: "2026-11-02", end: "2026-11-04", attendees: ["olya@example.com", "not an email"] });
    const trip = cal.requests.at(-1)!;
    expect(trip.body).toMatchObject({ start: { date: "2026-11-02" }, end: { date: "2026-11-05" }, attendees: [{ email: "olya@example.com" }] });
    expect(trip.query.get("sendUpdates")).toBe("all");
    expect(await h.invokeText("create_event", { title: "Bad", start: "2026-10-29T10:00", end: "2026-10-29T09:00" })).toBe("end must be after start");
  });

  it("changes and deletes events, passing Google's errors on", async () => {
    expect(await h.invokeText("update_event", { id: "e1", start: "2026-10-28T10:00", end: "2026-10-28T10:30" })).toBe("Changed: Wed 28 Oct 10:00–10:30: Standup [id e1]");
    expect(cal.requests.at(-1)).toMatchObject({ method: "PATCH", path: "/calendars/primary/events/e1" });
    expect(await h.invokeText("update_event", { id: "e1" })).toMatch(/^Nothing to change/);
    expect(await h.invokeText("delete_event", { id: "e2" })).toBe("Deleted the event e2.");
    expect(await h.invokeText("delete_event", { id: "missing" })).toBe("Google Calendar: Not Found");
  });

  it("says how to connect when Google is not connected, and what Google said otherwise", async () => {
    connected = false;
    expect(await h.invokeText("events")).toMatch(/^Google Calendar is not connected\. Call hub_integration_connect with id google-calendar/);
    connected = true;
    token = "at-expired";
    expect(await h.invokeText("calendars")).toBe("Google Calendar: Invalid Credentials");
    token = "at-good";
  });

  it("gives the morning digest today's plan and a later one tomorrow's", async () => {
    expect(await h.hook("digest.compose", { date: "2026-10-28", time: "09:00", timezone: "Asia/Almaty" })).toEqual({
      title: "Today in your calendar",
      body: "all day Day off\n09:00–09:15 Standup\n19:00–21:00 Dinner with Olya, Home",
    });
    const evening = (await h.hook("digest.compose", { date: "2026-10-27", time: "19:00", timezone: "Asia/Almaty" })) as any;
    expect(evening.title).toBe("Tomorrow in your calendar");
    expect(cal.requests.at(-1)!.query.get("timeMin")).toBe("2026-10-28T00:00:00+05:00");
    connected = false;
    expect(await h.hook("digest.compose", { date: "2026-10-28", time: "09:00", timezone: "Asia/Almaty" })).toBeFalsy();
    connected = true;
    h.setSettings({ digest: false, apiBaseUrl: `http://127.0.0.1:${(cal.server.address() as any).port}` });
    await new Promise((r) => setTimeout(r, 50));
    expect(await h.hook("digest.compose", { date: "2026-10-28", time: "09:00", timezone: "Asia/Almaty" })).toBeFalsy();
  });
});
