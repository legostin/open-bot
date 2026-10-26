// HTTP API: authenticated routes for the UI, public webhooks for event triggers.
// Errors shown by the UI carry the catalog message in the reader's language plus the code and params;
// webhook responses go to other programs and stay in English.

import type { PluginHttpRequest, PluginHttpResponse } from "@owlbot/plugin-sdk";
import { NotFoundError, type TriggerEngine } from "./engine.ts";
import type { TriggerError } from "./errors.ts";
import { describeSchedule } from "./schedule.ts";
import type { Trigger, TriggerInput } from "./types.ts";
import { ValidationError } from "./validate.ts";

export function view(e: TriggerEngine, t: Trigger) {
  return { ...t, nextRunAt: t.state.nextRunAt ?? null, webhookUrl: e.webhookUrl(t) ?? null, scheduleText: describeSchedule(t) };
}

const ok = (body: unknown, status = 200): PluginHttpResponse => ({ status, body });
const failure = (e: TriggerEngine, req: PluginHttpRequest, err: TriggerError, status: number): PluginHttpResponse =>
  ok({ error: e.ctx.i18n.t(`error.${err.code}`, err.params, req.locale), code: err.code, params: err.params }, status);
const body = (req: PluginHttpRequest): TriggerInput => (req.body && typeof req.body === "object" ? (req.body as TriggerInput) : {});

export async function handleHttp(e: TriggerEngine, req: PluginHttpRequest): Promise<PluginHttpResponse> {
  if (req.public) return e.webhook(req);
  const method = req.method.toUpperCase();
  const path = req.path.replace(/\/+$/, "") || "/";
  try {
    if (path === "/triggers") {
      if (method === "GET") return ok({ triggers: e.list().map((t) => view(e, t)), timezone: e.tz, publicUrl: e.publicUrl, agents: await e.agents() });
      if (method === "POST") return ok(view(e, await e.create(body(req), { createdBy: "user" })), 201);
      return ok({ error: "method not allowed" }, 405);
    }
    const m = /^\/triggers\/([A-Za-z0-9_-]+)(?:\/(run|runs|check))?$/.exec(path);
    if (m) {
      const [, id, sub] = m;
      const t = e.require(id);
      if (!sub && method === "GET") return ok(view(e, t));
      if (!sub && method === "PATCH") return ok(view(e, await e.update(id, body(req))));
      if (!sub && method === "DELETE") {
        await e.remove(id);
        return ok({ ok: true });
      }
      if (sub === "run" && method === "POST") return ok(await e.runNow(id, { force: true }));
      if (sub === "check" && method === "POST") return ok(await e.checkNow(id));
      if (sub === "runs" && method === "GET") return ok({ runs: await e.runsWithStatus(id) });
      return ok({ error: "method not allowed" }, 405);
    }
    return ok({ error: "not found" }, 404);
  } catch (err: any) {
    if (err instanceof ValidationError) return failure(e, req, err, 400);
    if (err instanceof NotFoundError) return failure(e, req, err, 404);
    return ok({ error: err?.message ?? String(err) }, 500);
  }
}
