// MCP between the hub and the official server, one JSON message per line (the stdio framing). A tool that needs a
// running Blender waits until Blender is open with the add-on listening; when that cannot be, the call gets the reason
// as its result instead of the server's bare "connection refused".
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface RelayOptions {
  /** From the hub. */
  from: Readable;
  /** To the server. */
  to: Writable;
  /** Back to the hub. */
  back: Writable;
  needsBlender(tool: string): boolean;
  ready(): Promise<void>;
}

export function relay(o: RelayOptions): void {
  const lines = createInterface({ input: o.from, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      o.to.write(line + "\n");
      return;
    }
    if (msg?.method !== "tools/call" || !o.needsBlender(String(msg.params?.name ?? ""))) {
      o.to.write(line + "\n");
      return;
    }
    o.ready().then(
      () => o.to.write(line + "\n"),
      (e) => o.back.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: e?.message ?? String(e) }], isError: true } }) + "\n"),
    );
  });
  lines.on("close", () => o.to.end());
}
