// Builtin plugin "memory": long-term memory about the user as markdown facts (one per file) in <dataDir>/memory,
// versioned with git when available, searchable via SQLite FTS5. Facts written from tainted sessions wait for review.

import type { PluginContext, PluginHttpRequest, PluginHttpResponse, PluginModule } from "@openbot/plugin-sdk";
import type { ToolCallContext, ToolResult } from "@openbot/shared";
import { Memory } from "./memory.ts";
import { INDEX_FILE, type Fact } from "./store.ts";
import { NotFoundError, PathError } from "./paths.ts";

function text(t: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

function factMeta(f: Fact): string {
  return [`path: ${f.path}`, f.tags.length ? `tags: ${f.tags.join(", ")}` : "", f.updated ? `updated: ${f.updated}` : "", f.source ? `source: ${f.source}` : ""]
    .filter(Boolean)
    .join(" · ");
}

function fail(e: any): PluginHttpResponse {
  if (e instanceof PathError) return { status: 400, body: { error: e.message } };
  if (e instanceof NotFoundError) return { status: 404, body: { error: e.message } };
  return { status: 500, body: { error: e?.message ?? String(e) } };
}

let memory: Memory | undefined;

const plugin: PluginModule = {
  async activate(ctx: PluginContext) {
    const settings = ctx.settings ?? {};
    const mem = new Memory({
      dataDir: ctx.dataDir,
      git: settings.git !== false,
      promptMaxChars: typeof settings.promptMaxChars === "number" ? settings.promptMaxChars : 4000,
      // Undocumented diagnostics/test switch: force the substring fallback instead of FTS5.
      forceSubstringSearch: settings.searchMode === "substring",
      warn: (m) => ctx.log.warn(m),
      changed: (path, action) => ctx.ui.emit("changed", { path, action }),
    });
    memory = mem;
    await mem.start();
    ctx.onSettingsChange((s) => {
      if (typeof s?.promptMaxChars === "number") mem.o.promptMaxChars = s.promptMaxChars;
    });

    // ---------- tools ----------

    ctx.tools.register({
      name: "search",
      description:
        "Search the user's long-term memory (full-text, ranked). Returns matching facts with their paths and snippets; " +
        "use memory_read for the full text. Search before asking the user something they may have told you already.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to look for (names, topics, preferences)." },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum results (default 10)." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler: (input: { query?: string; limit?: number }) => {
        const query = String(input.query ?? "").trim();
        if (!query) return text("Error: query is required", true);
        const hits = mem.search(query, input.limit ?? 10);
        if (!hits.length) return text(`No facts match "${query}".`);
        return text(
          hits.map((h, i) => `${i + 1}. ${h.path} — ${h.title}${h.tags.length ? ` [${h.tags.join(", ")}]` : ""}${h.snippet ? `\n   ${h.snippet}` : ""}`).join("\n"),
        );
      },
    });

    ctx.tools.register({
      name: "read",
      description: 'Read one memory fact by path (e.g. "people/anna.md", "profile.md"), or "MEMORY.md" for the index of all facts.',
      effect: "read",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Fact path relative to the memory root." } },
        required: ["path"],
        additionalProperties: false,
      },
      handler: (input: { path?: string }) => {
        if (String(input.path ?? "").trim() === INDEX_FILE) return text(mem.store.raw(INDEX_FILE) ?? mem.store.indexMarkdown());
        const { path, fact, review } = mem.get(String(input.path ?? ""));
        if (fact) {
          const note = review ? "\n\n[A newer version of this fact is waiting for the user's review.]" : "";
          return text(`# ${fact.title}\n${factMeta(fact)}\n\n${fact.body || "(empty)"}${note}`);
        }
        if (review) return text(`[Pending review: not approved by the user yet]\n# ${review.title}\n${factMeta(review)}\n\n${review.body || "(empty)"}`);
        return text(`Error: no fact at ${path}. Use memory_search or memory_list to find facts.`, true);
      },
    });

    ctx.tools.register({
      name: "list",
      description: 'List memory facts (title, path, tags), optionally only inside one folder such as "people", "projects" or "notes".',
      effect: "read",
      inputSchema: {
        type: "object",
        properties: { dir: { type: "string", description: "Folder relative to the memory root; omit for everything." } },
        additionalProperties: false,
      },
      handler: (input: { dir?: string }) => {
        const { dir, groups, review } = mem.list(input.dir);
        const lines: string[] = [];
        let n = 0;
        for (const g of groups) {
          lines.push(`${g.dir || "(root)"}:`);
          for (const f of g.facts) {
            if (n++ >= 500) break;
            lines.push(`- ${f.path} — ${f.title}${f.tags.length ? ` [${f.tags.join(", ")}]` : ""}`);
          }
        }
        if (!lines.length) lines.push(dir ? `No facts in ${dir}/.` : "Memory is empty.");
        if (n > 500) lines.push(`… ${n - 500} more`);
        if (review) lines.push("", `${review} fact(s) are waiting for the user's review (not listed, not searchable).`);
        return text(lines.join("\n"));
      },
    });

    ctx.tools.register({
      name: "write",
      description:
        "Save a durable fact about the user to long-term memory (one fact per file, markdown). " +
        "Without `path` a new note is created in notes/. Pass an existing path to update a fact: `content` replaces the old text, " +
        "so include everything that should stay (read it first). Folders: profile.md (who the user is, key preferences), people/, projects/, notes/. " +
        "Never store passwords, tokens or other secrets.",
      effect: "local-write",
      approvalSummary: "Запомнить: {title}",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: 'Optional fact path, e.g. "people/anna.md" or "profile.md" (must end with .md).' },
          title: { type: "string", description: "Short title of the fact." },
          content: { type: "string", description: "Markdown text of the fact." },
          tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
        },
        required: ["title", "content"],
        additionalProperties: false,
      },
      handler: async (input: { path?: string; title?: string; content?: string; tags?: string[] }, call: ToolCallContext) => {
        const r = await mem.write(
          { path: input.path, title: String(input.title ?? ""), content: String(input.content ?? ""), tags: input.tags },
          { source: `${call.agentId}/${call.sessionId}`, tainted: !!call.tainted },
        );
        if (r.status === "review") {
          return text(
            `Queued ${r.path} for the user's review. This session has read untrusted content (web pages, emails or external tools), ` +
              "so new memories from it are held until the user approves them on the Memory page. Until then the fact is NOT in memory_search " +
              "or the memory index. Do not retry; tell the user briefly if it matters.",
          );
        }
        return text(`${r.status === "created" ? "Created" : "Updated"} ${r.path}.`);
      },
    });

    ctx.tools.register({
      name: "forget",
      description: "Delete a fact from memory by path (the deletion is recorded in the memory's history).",
      effect: "local-write",
      approvalSummary: "Забыть: {path}",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Fact path, e.g. notes/old-plan.md." } },
        required: ["path"],
        additionalProperties: false,
      },
      handler: async (input: { path?: string }) => {
        const r = await mem.forget(String(input.path ?? ""));
        return text(`Forgot ${r.path}.`);
      },
    });

    // ---------- hook ----------

    ctx.hooks.on("session.start", () => ({ appendSystemPrompt: mem.sessionPrompt() }));

    // ---------- HTTP for the UI ----------

    ctx.http.handle(async (req: PluginHttpRequest): Promise<PluginHttpResponse> => {
      if (req.public) return { status: 404, body: { error: "Не найдено" } };
      const body = (req.body ?? {}) as Record<string, any>;
      const route = `${req.method.toUpperCase()} ${req.path.replace(/\/+$/, "") || "/"}`;
      try {
        switch (route) {
          case "GET /tree":
            return { status: 200, body: mem.tree() };
          case "GET /file": {
            const p = String(req.query.path ?? "");
            if (p === INDEX_FILE) return { status: 200, body: { path: INDEX_FILE, title: "Индекс памяти", raw: mem.store.raw(INDEX_FILE) ?? "", body: mem.store.raw(INDEX_FILE) ?? "", generated: true } };
            const { path, fact, review } = mem.get(p);
            const f = req.query.review === "1" ? review : (fact ?? review);
            if (!f) return { status: 404, body: { error: `Факт не найден: ${path}` } };
            return { status: 200, body: { ...f, raw: mem.serialize(f), pendingReview: !!review } };
          }
          case "PUT /file": {
            const f = await mem.putRaw(String(body.path ?? ""), String(body.content ?? ""));
            return { status: 200, body: { ...f, raw: mem.serialize(f) } };
          }
          case "DELETE /file":
            return { status: 200, body: await mem.forget(String(req.query.path ?? body.path ?? "")) };
          case "GET /search":
            return { status: 200, body: { results: mem.search(String(req.query.q ?? ""), Number(req.query.limit ?? 20)) } };
          case "GET /review":
            return {
              status: 200,
              body: {
                items: mem.reviewItems().map((r) => {
                  const current = mem.store.facts.get(r.path);
                  return { ...r, current: current && !r.inPlace ? { title: current.title, body: current.body, tags: current.tags, updated: current.updated } : undefined };
                }),
              },
            };
          case "POST /review/approve":
            return { status: 200, body: await mem.approve(String(body.path ?? "")) };
          case "POST /review/reject":
            return { status: 200, body: await mem.reject(String(body.path ?? "")) };
          default:
            return { status: 404, body: { error: "Не найдено" } };
        }
      } catch (e) {
        return fail(e);
      }
    });
  },

  async deactivate() {
    await memory?.stop();
  },
};

export default plugin;
