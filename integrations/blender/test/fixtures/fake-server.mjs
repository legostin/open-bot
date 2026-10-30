// A stand-in for the official Blender MCP server: a documentation tool, and a scene tool that asks the add-on.
import { createConnection } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "blender-mcp", version: "1.0.3" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "get_objects_summary", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    { name: "search_api_docs", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (r) => {
  if (r.params.name === "search_api_docs") return { content: [{ type: "text", text: "bpy.ops.mesh.primitive_cube_add" }] };
  const scene = await new Promise((resolve) => {
    const c = createConnection(Number(process.env.BLENDER_MCP_PORT), "127.0.0.1");
    let d = "";
    c.on("data", (x) => (d += x));
    c.on("end", () => resolve(d.trim()));
    c.on("error", () => resolve("connection refused"));
  });
  return { content: [{ type: "text", text: `${scene} | ${process.env.BLENDER_PATH}` }] };
});
await server.connect(new StdioServerTransport());
