import { describe, expect, it } from "vitest";
import { DemoError, Router } from "./router";

describe("demo hub router", () => {
  it("matches a pattern and hands over its params, the query and the body", async () => {
    const r = new Router();
    r.route("POST", "/api/conversations/:id/messages", ({ params, query, body }) => ({ id: params.id, limit: query.get("limit"), body }));
    const res = await r.handle("POST", new URL("http://x/api/conversations/c%201/messages?limit=5"), { text: "hi" });
    expect(res).toEqual({ status: 200, body: { id: "c 1", limit: "5", body: { text: "hi" } } });
  });

  it("tells methods apart and prefers the first route that matches", async () => {
    const r = new Router();
    r.route("GET", "/api/tasks", () => "list");
    r.route("GET", "/api/tasks/:id", () => "one");
    r.route("POST", "/api/tasks", () => "made");
    expect((await r.handle("GET", new URL("http://x/api/tasks"))).body).toBe("list");
    expect((await r.handle("GET", new URL("http://x/api/tasks/t1"))).body).toBe("one");
    expect((await r.handle("POST", new URL("http://x/api/tasks"))).body).toBe("made");
  });

  it("answers 404 for what it does not know and reports it", async () => {
    const unknown: string[] = [];
    const r = new Router((m, p) => unknown.push(`${m} ${p}`));
    const res = await r.handle("GET", new URL("http://x/api/nowhere?x=1"));
    expect(res.status).toBe(404);
    expect(unknown).toEqual(["GET /api/nowhere"]);
  });

  it("turns a DemoError into its status", async () => {
    const r = new Router();
    r.route("DELETE", "/api/feeds/:id", () => {
      throw new DemoError(409, "not in the demo");
    });
    expect(await r.handle("DELETE", new URL("http://x/api/feeds/f1"))).toEqual({ status: 409, body: { error: "not in the demo" } });
  });
});
