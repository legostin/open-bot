// A tiny in-process fake of the Telegram Bot API for plugin tests.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockCall {
  method: string;
  /** JSON params; for multipart calls the text fields (JSON fields parsed) and files as {file, name, type, size}. */
  params: any;
}

/** A file part of a multipart call. */
export interface MockFile {
  file: true;
  name: string;
  type: string;
  size: number;
}

export interface MockTelegram {
  url: string;
  calls: MockCall[];
  /** Queue an update; update_id is assigned automatically. */
  push(update: Record<string, unknown>): number;
  /** Resolve with the first call of `method` (after index `from`) that matches `pred`. */
  waitFor(method: string, pred?: (params: any) => boolean, opts?: { from?: number; timeoutMs?: number }): Promise<MockCall>;
  callsOf(method: string, pred?: (params: any) => boolean): MockCall[];
  /** Make the next call of `method` fail with this Telegram error. */
  failNext(method: string, code: number, description: string): void;
  close(): Promise<void>;
}

/** maxPollSec: how long an empty getUpdates may hold (capped for fast tests; raise it to act like Telegram). */
export async function startMockTelegram(token: string, opts: { maxPollSec?: number } = {}): Promise<MockTelegram> {
  const maxPollSec = opts.maxPollSec ?? 2;
  const calls: MockCall[] = [];
  const updates: Array<Record<string, unknown> & { update_id: number }> = [];
  const failures = new Map<string, { code: number; description: string }>();
  let nextUpdate = 1000;
  let nextMessage = 1;
  let pollWaiters: Array<() => void> = [];
  let callWaiters: Array<() => void> = [];

  const notifyCalls = () => {
    const w = callWaiters;
    callWaiters = [];
    w.forEach((f) => f());
  };

  const handle = async (method: string, params: any): Promise<{ status: number; body: unknown }> => {
    const fail = failures.get(method);
    if (fail) {
      failures.delete(method);
      return { status: fail.code, body: { ok: false, error_code: fail.code, description: fail.description } };
    }
    switch (method) {
      case "getMe":
        return ok({ id: 4242, is_bot: true, first_name: "Owlbot", username: "owlbot_test_bot" });
      case "getUpdates": {
        const offset = Number(params.offset ?? 0);
        const pending = () => updates.filter((u) => u.update_id >= offset);
        if (!pending().length && params.timeout > 0) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(done, Math.min(Number(params.timeout), maxPollSec) * 1000);
            function done() {
              clearTimeout(t);
              pollWaiters = pollWaiters.filter((w) => w !== done);
              resolve();
            }
            pollWaiters.push(done);
          });
        }
        return ok(pending());
      }
      case "sendMessage":
        return ok({ message_id: nextMessage++, chat: { id: params.chat_id, type: "private" }, date: Math.floor(Date.now() / 1000), text: params.text });
      case "sendPhoto":
      case "sendDocument":
      case "sendLocation":
        return ok({ message_id: nextMessage++, chat: { id: Number(params.chat_id), type: "private" }, date: Math.floor(Date.now() / 1000) });
      case "sendMediaGroup":
        return ok((params.media as unknown[]).map(() => ({ message_id: nextMessage++, chat: { id: Number(params.chat_id), type: "private" }, date: Math.floor(Date.now() / 1000) })));
      case "editMessageText":
      case "editMessageReplyMarkup":
      case "answerCallbackQuery":
      case "sendChatAction":
      case "deleteWebhook":
      case "setMyCommands":
        return ok(true);
      default:
        return { status: 404, body: { ok: false, error_code: 404, description: "Not Found: method not found" } };
    }
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      const type = req.headers["content-type"] ?? "";
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
      let status = 404;
      let body: unknown = { ok: false, error_code: 404, description: "Not Found" };
      if (m && m[1] !== token) {
        status = 401;
        body = { ok: false, error_code: 401, description: "Unauthorized" };
      } else if (m) {
        const params = type.startsWith("multipart/form-data") ? await multipart(raw, type) : raw.length ? JSON.parse(raw.toString("utf8")) : {};
        calls.push({ method: m[2], params });
        notifyCalls();
        ({ status, body } = await handle(m[2], params));
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const callsOf = (method: string, pred: (p: any) => boolean = () => true) => calls.filter((c) => c.method === method && pred(c.params));

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    push(update) {
      const update_id = nextUpdate++;
      updates.push({ update_id, ...update });
      const w = pollWaiters;
      pollWaiters = [];
      w.forEach((f) => f());
      return update_id;
    },
    callsOf,
    waitFor(method, pred = () => true, opts = {}) {
      const from = opts.from ?? 0;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; calls: ${JSON.stringify(calls.slice(from).map((c) => c.method))}`)), opts.timeoutMs ?? 8000);
        const check = () => {
          const hit = calls.slice(from).find((c) => c.method === method && pred(c.params));
          if (hit) {
            clearTimeout(timer);
            resolve(hit);
          } else callWaiters.push(check);
        };
        check();
      });
    },
    failNext(method, code, description) {
      failures.set(method, { code, description });
    },
    close: () =>
      new Promise<void>((r) => {
        pollWaiters.forEach((f) => f());
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Text fields as sent (JSON ones parsed back), files described. */
async function multipart(raw: Buffer, type: string): Promise<Record<string, unknown>> {
  const form = await new Response(new Uint8Array(raw), { headers: { "content-type": type } }).formData();
  const out: Record<string, unknown> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") {
      try {
        out[k] = /^[[{]/.test(v) ? JSON.parse(v) : v;
      } catch {
        out[k] = v;
      }
    } else out[k] = { file: true, name: v.name, type: v.type, size: v.size } satisfies MockFile;
  }
  return out;
}

function ok(result: unknown) {
  return { status: 200, body: { ok: true, result } };
}
