// Fake `claude` CLI for tests: emits stream-json like Claude Code 2.x.
const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
if (args[0] === "--version") {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}
if (args[0] === "auth") {
  console.log(JSON.stringify({ loggedIn: process.env.FAKE_LOGGED_IN === "1", authMethod: "claude.ai" }));
  process.exit(0);
}
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : undefined;
  if (resume === "missing") {
    process.stderr.write("No conversation found with session ID: missing\n");
    process.exit(1);
  }
  const sid = resume ?? "sess-1";
  if (input.includes("LIMIT")) {
    out({ type: "system", subtype: "init", session_id: sid, mcp_servers: [{ name: "openbot", status: "connected" }] });
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1893456000, rateLimitType: "five_hour" } });
    out({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1893456000", session_id: sid, usage: {} });
    process.exit(1);
  }
  out({ type: "system", subtype: "init", session_id: sid, mcp_servers: [{ name: "openbot", status: "connected" }] });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `echo:${input}` } }, parent_tool_use_id: null, api_message_id: "m1", session_id: sid });
  out({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: `echo:${input}` }, { type: "tool_use", id: "tu1", name: "mcp__openbot__notify", input: { level: "silent", title: "x" } }] }, parent_tool_use_id: null, session_id: sid });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "ok" }] }] }, parent_tool_use_id: null, session_id: sid });
  const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "default";
  out({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: `resume=${resume ?? "none"} model=${model}` }] }, parent_tool_use_id: null, session_id: sid });
  out({ type: "assistant", message: { id: "m3", content: [{ type: "text", text: "subagent text" }] }, parent_tool_use_id: "tu9", session_id: sid });
  out({ session_id: sid, type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 } });
});
