// Fake `claude` that records its environment and arguments in the working directory, then answers like Claude Code.
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
if (args[0] === "--version") {
  console.log("1.0.0 (Claude Code)");
  process.exit(0);
}
if (args[0] === "auth") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
  process.exit(0);
}
// stream-json input: answer the first user message (echoed back as taken), then exit when stdin closes.
let buf = "";
let answered = false;
process.stdin.on("data", (c) => {
  buf += c;
  if (answered || !buf.includes("\n")) return;
  answered = true;
  const pick = (k) => process.env[k] ?? null;
  writeFileSync(
    "env.json",
    JSON.stringify({ cwd: process.cwd(), args, TZ: pick("TZ"), NODE_OPTIONS: pick("NODE_OPTIONS"), ANTHROPIC_BASE_URL: pick("ANTHROPIC_BASE_URL"), OWLBOT_NODE_HOME: pick("OWLBOT_NODE_HOME") }),
  );
  out({ type: "system", subtype: "init", session_id: "s-env", mcp_servers: [{ name: "owlbot", status: "connected" }] });
  out({ type: "user", message: JSON.parse(buf.slice(0, buf.indexOf("\n"))).message, session_id: "s-env", isReplay: true });
  out({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s-env", usage: {} });
});
process.stdin.on("end", () => process.exit(0));
