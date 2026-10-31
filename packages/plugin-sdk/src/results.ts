import type { ToolResult } from "@piomio/shared";

export function textResult(text: string, meta?: ToolResult["_meta"]): ToolResult {
  return { content: [{ type: "text", text }], ...(meta ? { _meta: meta } : {}) };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
