// Scriptable brain for core integration tests.
// "CALL <tool> <json>" calls a hub tool over MCP; "LIMIT" makes brain `fake` hit its limit; "PROMPT?" echoes the instructions.
// Group chats: "HANDOFF <id>" on the last line replies "over to @<id>"; "ECHO?" anywhere echoes the turn's "[...]" lines;
// "SLOW" at the end of the last line keeps the turn going until it is interrupted (or 5 s pass), "BRIEF" for 0.8 s.
// Brain `fake` takes input into such a turn (steer): the turn then ends with "fake also heard: <its last line>";
// `fake2` cannot steer, so the hub sends it as the next turn.
// "TIME?" answers with the turn's "[Now: …]" line (or "none"); a turn with files answers with their paths and the note.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PluginContext } from "@owlbot/plugin-sdk";
import type { BrainEvent, BrainSessionOptions } from "@owlbot/shared";

/** Sessions in a "SLOW" turn: interrupt() ends it, and so does input steered into it. */
const slow = new Map<string, () => void>();
const steered = new Map<string, string[]>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

async function mcpCall(o: BrainSessionOptions, name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  const r = await fetch(o.mcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${o.mcp.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const j: any = await r.json();
  if (j.error) return { text: j.error.message, isError: true };
  return { text: (j.result.content ?? []).map((c: any) => c.text ?? "").join("\n"), isError: !!j.result.isError };
}

export default {
  async activate(ctx: PluginContext) {
    ctx.tools.register({
      name: "send",
      description: "Send a message somewhere (external effect)",
      effect: "external",
      approvalSummary: "Отправить {text}",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      handler: async (input: { text: string }) => `sent: ${input.text}`,
    });
    for (const id of ["fake", "fake2"]) {
      ctx.brains.register({
        id,
        label: id,
        variants: id === "fake2" ? ["a", "b"] : undefined,
        probe: async () => ({ available: true, authenticated: true }),
        createSession: async (o: BrainSessionOptions) => ({
          async *send(raw): AsyncGenerator<BrainEvent> {
            // The hub's "[Now: …]" line comes first; the scripts below read the rest.
            const clock = /^\[Now: [^\]]*\]\n/.exec(raw.text)?.[0].trim();
            const turn = { ...raw, text: clock ? raw.text.slice(clock.length + 1) : raw.text };
            if (turn.text.trim() === "TIME?") {
              yield { type: "text", delta: `${id} time: ${clock ?? "none"}` };
              yield { type: "done", resumeToken: `${id}-resume` };
              return;
            }
            // Files with the message: where each one is in this session's workspace, and the hub's note.
            const noteAt = turn.text.search(/(?<=^|\n)\[The user attached/);
            if (noteAt >= 0) {
              const files = (turn.attachments ?? []).map((a) => `${a}:${existsSync(join(o.workspace, a)) ? "here" : "missing"}`);
              yield { type: "text", delta: `${id} files: ${files.join(", ") || "none"} | note: ${turn.text.slice(noteAt).split("\n").join(" / ")}` };
              yield { type: "done", resumeToken: `${id}-resume` };
              return;
            }
            if (id === "fake" && turn.text.includes("LIMIT")) {
              yield { type: "limit_hit", resetAt: new Date(Date.now() + 3600_000).toISOString(), detail: "fake limit" };
              yield { type: "done" };
              return;
            }
            // Only the turn's own last line: a fresh session's prompt carries the dialog so far.
            if (/^THINK\b/.test(turn.text.trim().split("\n").at(-1) ?? "")) {
              // Narration, a native tool, then the answer: how a real brain replies after using tools.
              yield { type: "text", delta: "Let me look." };
              yield { type: "tool_call", id: "t1", name: "Read", input: { path: "notes.md" } };
              yield { type: "tool_result", id: "t1", output: "the notes" };
              yield { type: "text", delta: `${id} found it` };
              yield { type: "done", resumeToken: `${id}-resume` };
              return;
            }
            // The instructions this session was opened with.
            if ((turn.text.trim().split("\n").at(-1) ?? "") === "PROMPT?") {
              yield { type: "text", delta: `${id} prompt: ${o.agent.prompt} | in system prompt: ${o.systemPrompt.includes(o.agent.prompt)}` };
              yield { type: "done", resumeToken: `${id}-resume` };
              return;
            }
            // A task's first turn ends with the hub's "When you are done…" line: its goal counts as the last line.
            const last = lastLine(turn.text.replace(/\n+When you are done[^\n]*\s*$/, ""));
            if (last.endsWith("SLOW") || last.endsWith("BRIEF")) {
              yield { type: "text", delta: `${id} is thinking` };
              await new Promise<void>((resolve) => {
                slow.set(o.sessionId, resolve);
                setTimeout(resolve, last.endsWith("SLOW") ? 5000 : 800);
              });
              slow.delete(o.sessionId);
              const more = steered.get(o.sessionId) ?? [];
              steered.delete(o.sessionId);
              if (more.length) {
                // After the hub has heard that the input was taken (it starts a new message for the rest).
                await sleep(150);
                yield { type: "text", delta: `${id} also heard: ${more.map(lastLine).join(" + ")}` };
              }
              yield { type: "done", resumeToken: `${id}-resume` };
              return;
            }
            const handoff = /HANDOFF (\S+)$/.exec(turn.text.trim().split("\n").at(-1) ?? "");
            if (handoff) {
              yield { type: "text", delta: `over to @${handoff[1]}` };
              yield { type: "done", resumeToken: `${id}-resume` };
              return;
            }
            if (turn.text.includes("ECHO?")) {
              const seen = turn.text.split("\n").filter((l) => l.startsWith("["));
              yield { type: "text", delta: `${id} saw: ${seen.join(" | ")}` };
              yield { type: "done", resumeToken: `${id}-resume` };
              return;
            }
            const m = /CALL (\S+) (\{.*\})/.exec(turn.text);
            if (m && !turn.text.includes("[System]")) {
              yield { type: "tool_call", id: "c1", name: m[1], input: JSON.parse(m[2]) };
              const r = await mcpCall(o, m[1], JSON.parse(m[2]));
              yield { type: "tool_result", id: "c1", output: r.text, isError: r.isError };
              yield { type: "text", delta: `tool said: ${r.text}` };
            } else {
              const last = turn.text.trim().split("\n").at(-1);
              yield { type: "text", delta: `${id} heard: ${last}` };
            }
            yield { type: "done", resumeToken: `${id}-resume` };
          },
          ...(id === "fake"
            ? {
                steer(turn: { text: string }) {
                  const wake = slow.get(o.sessionId);
                  if (!wake) return false;
                  steered.set(o.sessionId, [...(steered.get(o.sessionId) ?? []), turn.text]);
                  wake();
                  return true;
                },
              }
            : {}),
          interrupt() {
            slow.get(o.sessionId)?.();
          },
          close() {},
        }),
      });
    }
  },
};
