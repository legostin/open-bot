// Asking the hub whether a brain's own action may go ahead (core: tools/native-permission.ts), over the session's MCP
// endpoint. Any failure is a no: the action stays inside the sandbox.

/** True when the hub (or the person, through it) allows `tool` with `input`. */
export async function askHub(mcp: { url: string; token: string }, permissionTool: string, tool: string, input: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetchImpl(mcp.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${mcp.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: permissionTool, arguments: { tool_name: tool, input } } }),
      // The person may take minutes to answer.
      signal: AbortSignal.timeout(16 * 60_000),
    });
    const j = (await r.json()) as { result?: { content?: Array<{ type: string; text?: string }> } };
    const text = j.result?.content?.find((c) => c.type === "text")?.text ?? "";
    return (JSON.parse(text) as { behavior?: string }).behavior === "allow";
  } catch {
    return false;
  }
}
