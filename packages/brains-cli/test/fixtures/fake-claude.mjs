// Fake `claude` CLI for tests: emits stream-json like Claude Code 2.x. `auth login` behaves like Claude Code without a
// terminal: prints the sign-in page, then reads the code from stdin ("good-code#xyz" signs in, HOME/.claude/.credentials.json).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const credentials = join(process.env.HOME || homedir(), ".claude", ".credentials.json");
const login = args[0] === "auth" && args[1] === "login";
if (args[0] === "--version") {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}
if (login) {
  console.log("Opening browser to sign in…");
  console.log("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=fake&response_type=code&state=xyz");
  process.stdout.write("Paste code here if prompted > ");
  let line = "";
  process.stdin.on("data", (c) => {
    line += c;
    if (!line.includes("\n")) return;
    if (line.trim() === "good-code#xyz") {
      mkdirSync(join(credentials, ".."), { recursive: true });
      writeFileSync(credentials, "{}");
      console.log("Login successful.");
      process.exit(0);
    }
    console.log("Login failed: Request failed with status code 400");
    process.exit(1);
  });
} else if (args[0] === "auth") {
  console.log(JSON.stringify({ loggedIn: process.env.FAKE_LOGGED_IN === "1" || existsSync(credentials), authMethod: "claude.ai" }));
  process.exit(0);
}
let input = "";
if (!login) process.stdin.on("data", (c) => (input += c));
if (!login) process.stdin.on("end", () => {
  const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : undefined;
  if (resume === "missing") {
    process.stderr.write("No conversation found with session ID: missing\n");
    process.exit(1);
  }
  const sid = resume ?? "sess-1";
  if (input.includes("LIMIT")) {
    out({ type: "system", subtype: "init", session_id: sid, mcp_servers: [{ name: "owlbot", status: "connected" }] });
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1893456000, rateLimitType: "five_hour" } });
    out({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1893456000", session_id: sid, usage: {} });
    process.exit(1);
  }
  out({ type: "system", subtype: "init", session_id: sid, mcp_servers: [{ name: "owlbot", status: "connected" }] });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `echo:${input}` } }, parent_tool_use_id: null, api_message_id: "m1", session_id: sid });
  out({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: `echo:${input}` }, { type: "tool_use", id: "tu1", name: "mcp__owlbot__notify", input: { level: "silent", title: "x" } }] }, parent_tool_use_id: null, session_id: sid });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "ok" }] }] }, parent_tool_use_id: null, session_id: sid });
  const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "default";
  out({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: `resume=${resume ?? "none"} model=${model}` }] }, parent_tool_use_id: null, session_id: sid });
  out({ type: "assistant", message: { id: "m3", content: [{ type: "text", text: "subagent text" }] }, parent_tool_use_id: "tu9", session_id: sid });
  out({ session_id: sid, type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 } });
});
