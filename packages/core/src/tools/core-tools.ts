// Tools implemented by the core itself (owner "core").

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ImageItem, MapMarker, MessagePart, ToolDescriptor, ToolResult } from "@owlbot/shared";
import type { ToolRegistry } from "./registry.ts";
import type { SkillIndex } from "../skills.ts";
import type { VaultService } from "../vault/service.ts";
import type { Store } from "../store.ts";
import type { Notifier } from "../notifier.ts";
import type { AgentRegistry } from "../agents.ts";
import { imageTypeOf, MAX_IMAGE_BYTES, parseImageUrl } from "../media.ts";

export interface CoreToolDeps {
  registry: ToolRegistry;
  skills: SkillIndex;
  vault: VaultService;
  store: Store;
  notifier: Notifier;
  agents: AgentRegistry;
  createTask: (t: { agentId: string; goal: string; title: string; parentConversationId?: string; parentTaskId?: string; background: boolean; createdBy: "agent" }) => { id: string; title: string };
  /** Add a card to the reply the agent is writing (SessionRunner.attachPart). */
  attachPart: (conversationId: string, part: MessagePart) => void;
  /** <dataDir>/workspaces: `file:` image sources are relative to it. */
  workspacesRoot: string;
}

const MAX_IMAGES = 10;
const MAX_MARKERS = 50;

const clip = (v: unknown, max: number): string | undefined => {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return s ? (s.length > max ? `${s.slice(0, max - 1)}…` : s) : undefined;
};

/** A number within [min, max], or an error text for the model. */
function coord(v: unknown, name: string, min: number, max: number): number | string {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) return `${name} must be a number from ${min} to ${max}`;
  return n;
}

/** `path` (relative to the agent's workspace) as a `file:` source under the workspaces root, or an error text. */
function workspaceImage(path: string, workspace: string, root: string): string | { error: string } {
  if (isAbsolute(path)) return { error: `${path}: give the path relative to your workspace` };
  let real: string;
  let realRoot: string;
  let realWorkspace: string;
  try {
    realRoot = realpathSync(root);
    realWorkspace = realpathSync(workspace);
    real = realpathSync(resolve(workspace, path));
  } catch {
    return { error: `${path}: no such file in your workspace` };
  }
  const inside = (dir: string) => real === dir || real.startsWith(dir + sep);
  if (!inside(realWorkspace) || !inside(realRoot)) return { error: `${path}: outside your workspace` };
  const st = statSync(real);
  if (!st.isFile()) return { error: `${path}: not a file` };
  if (!imageTypeOf(real)) return { error: `${path}: not an image (png, jpg, gif, webp, avif, bmp or svg)` };
  if (st.size > MAX_IMAGE_BYTES) return { error: `${path}: larger than 10 MB` };
  return `file:${relative(realRoot, real).split(sep).join("/")}`;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

export function registerCoreTools(d: CoreToolDeps): void {
  const reg = (spec: Omit<ToolDescriptor, "owner">, fn: (input: any, ctx: any) => Promise<ToolResult> | ToolResult) =>
    d.registry.register({ ...spec, owner: "core" }, async (input, ctx) => fn(input ?? {}, ctx));

  reg(
    {
      name: "notify",
      description:
        "Tell the user something proactively. level: silent (log only), digest (goes into the next summary), notify (deliver now — interrupts the user), ask (needs the user's decision). Use sparingly.",
      effect: "local-write",
      inputSchema: {
        type: "object",
        properties: {
          level: { type: "string", enum: ["silent", "digest", "notify", "ask"] },
          title: { type: "string", description: "Short headline (≤ 80 chars)" },
          body: { type: "string", description: "Concise details" },
        },
        required: ["level", "title"],
      },
    },
    async (i, ctx) => {
      const task = ctx.taskId ? d.store.getTask(ctx.taskId) : undefined;
      const n = await d.notifier.notify({
        level: i.level,
        title: String(i.title ?? "").slice(0, 200),
        body: String(i.body ?? ""),
        agentId: ctx.agentId,
        taskId: ctx.taskId,
        triggerId: task?.triggerId,
        conversationId: ctx.conversationId,
      });
      return text(`Notification recorded (level: ${n.effectiveLevel}${n.reason ? `, ${n.reason}` : ""}).`);
    },
  );

  reg(
    {
      name: "task_delegate",
      description: "Start a separate task for an agent (yourself or a specialist). It runs in parallel and reports back here when done. Returns the task id.",
      effect: "local-write",
      inputSchema: {
        type: "object",
        properties: {
          goal: { type: "string", description: "Complete, self-contained instructions" },
          title: { type: "string" },
          agent: { type: "string", description: "Agent id (default: same agent). See task_agents." },
        },
        required: ["goal"],
      },
    },
    (i, ctx) => {
      const agentId = i.agent ? String(i.agent) : ctx.agentId;
      if (!d.agents.get(agentId)) return text(`No agent ${agentId}`, true);
      const t = d.createTask({
        agentId,
        goal: String(i.goal),
        title: String(i.title ?? String(i.goal).slice(0, 60)),
        parentConversationId: ctx.conversationId,
        parentTaskId: ctx.taskId,
        background: ctx.background,
        createdBy: "agent",
      });
      return text(`Task created: ${t.id} “${t.title}”. The result will arrive here as a message.`);
    },
  );

  reg(
    { name: "task_agents", description: "List available agents you can delegate to.", effect: "read", inputSchema: { type: "object", properties: {} } },
    () => text(d.agents.list().map((a) => `- ${a.id}: ${a.name} — ${a.description}`).join("\n")),
  );

  reg(
    {
      name: "task_status",
      description: "Get status and result of a task by id.",
      effect: "read",
      inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
    },
    (i) => {
      const t = d.store.getTask(String(i.taskId));
      if (!t) return text("Task not found", true);
      return text(JSON.stringify({ id: t.id, title: t.title, status: t.status, result: t.result, error: t.error }, null, 2));
    },
  );

  reg(
    {
      name: "skill_load",
      description: "Load the full instructions (SKILL.md) of a skill by name.",
      effect: "read",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    (i) => {
      const s = d.skills.load(String(i.name));
      return s ? text(s) : text(`Skill ${i.name} not found`, true);
    },
  );

  reg(
    {
      name: "show_images",
      description:
        "Show the user pictures right in the chat: one image appears as a card, 2–10 as a swipeable carousel, and they open full screen on click. " +
        "When your reply also goes to the user's phone (Telegram), the images go with it. Use it whenever a picture says more than words: photos of a place or product, " +
        "charts and screenshots you made, search results with images. Each image is either `url` (a public http(s) image address) or `path` " +
        "(an image file in your workspace, relative to it: png, jpg, gif, webp, avif, bmp or svg, up to 10 MB). Add a short `caption` in the user's language. " +
        "Do not repeat the images as markdown in your text; refer to them in words.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          images: {
            type: "array",
            minItems: 1,
            maxItems: MAX_IMAGES,
            items: {
              type: "object",
              properties: {
                url: { type: "string", description: "Public http(s) address of the image" },
                path: { type: "string", description: "Image file in your workspace, relative to it" },
                caption: { type: "string", description: "Shown under the image (≤ 200 chars)" },
                alt: { type: "string", description: "What the image shows, for screen readers" },
              },
            },
          },
        },
        required: ["images"],
      },
    },
    (i, ctx) => {
      const list: unknown[] = Array.isArray(i.images) ? i.images : i.url || i.path ? [i] : [];
      if (!list.length) return text("Give images: [{url} or {path}, …].", true);
      if (list.length > MAX_IMAGES) return text(`At most ${MAX_IMAGES} images at once; split them into several calls.`, true);
      const items: ImageItem[] = [];
      const problems: string[] = [];
      for (const [n, raw] of list.entries()) {
        const it = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const label = `image ${n + 1}`;
        let src: string | undefined;
        if (typeof it.path === "string" && it.path.trim()) {
          if (ctx.machineId !== "local") {
            problems.push(`${label}: files on ${ctx.machineId} cannot be shown; use a public url`);
            continue;
          }
          const r = workspaceImage(it.path.trim(), ctx.workspace, d.workspacesRoot);
          if (typeof r !== "string") {
            problems.push(`${label}: ${r.error}`);
            continue;
          }
          src = r;
        } else if (typeof it.url === "string" && it.url.trim()) {
          const u = parseImageUrl(it.url.trim());
          if (!u) {
            problems.push(`${label}: url must be a public http(s) address`);
            continue;
          }
          src = u.href;
        } else {
          problems.push(`${label}: give url or path`);
          continue;
        }
        items.push({ src, ...(clip(it.alt, 300) ? { alt: clip(it.alt, 300) } : {}), ...(clip(it.caption, 200) ? { caption: clip(it.caption, 200) } : {}) });
      }
      if (problems.length) return text(`Nothing shown. ${problems.join("; ")}.`, true);
      d.attachPart(ctx.conversationId, { type: "images", items });
      return text(
        `The user now sees ${items.length === 1 ? "the image" : `a carousel of ${items.length} images`} in the chat (and in Telegram, if your reply goes there). ` +
          "Do not paste it again as markdown.",
      );
    },
  );

  reg(
    {
      name: "show_map",
      description:
        "Show the user an interactive OpenStreetMap map right in the chat, centred on a point, with optional labelled markers; when your reply " +
        "also goes to Telegram, the map goes with it as a location pin. Use it for places, addresses, stops on a route, meeting points, \"where is…\" questions. " +
        "Coordinates are WGS84 decimal degrees. Without zoom the map fits all markers; zoom 3 is a continent, 10 a city, 15 streets, 18 buildings.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          lat: { type: "number", minimum: -90, maximum: 90, description: "Latitude of the centre" },
          lon: { type: "number", minimum: -180, maximum: 180, description: "Longitude of the centre" },
          zoom: { type: "integer", minimum: 1, maximum: 19 },
          title: { type: "string", description: "Shown above the map, e.g. the place name (≤ 120 chars)" },
          markers: {
            type: "array",
            maxItems: MAX_MARKERS,
            description: "Points to pin; without markers the centre gets one",
            items: {
              type: "object",
              properties: { lat: { type: "number" }, lon: { type: "number" }, label: { type: "string", description: "≤ 120 chars" } },
              required: ["lat", "lon"],
            },
          },
        },
        required: ["lat", "lon"],
      },
    },
    (i, ctx) => {
      const lat = coord(i.lat, "lat", -90, 90);
      const lon = coord(i.lon, "lon", -180, 180);
      if (typeof lat === "string" || typeof lon === "string") return text([lat, lon].filter((x) => typeof x === "string").join("; "), true);
      let zoom: number | undefined;
      if (i.zoom !== undefined && i.zoom !== null) {
        const z = coord(i.zoom, "zoom", 1, 19);
        if (typeof z === "string") return text(z, true);
        zoom = Math.round(z);
      }
      const rawMarkers: unknown[] = Array.isArray(i.markers) ? i.markers : [];
      if (rawMarkers.length > MAX_MARKERS) return text(`At most ${MAX_MARKERS} markers.`, true);
      const markers: MapMarker[] = [];
      for (const [n, raw] of rawMarkers.entries()) {
        const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const mlat = coord(m.lat, `markers[${n}].lat`, -90, 90);
        const mlon = coord(m.lon, `markers[${n}].lon`, -180, 180);
        if (typeof mlat === "string" || typeof mlon === "string") return text([mlat, mlon].filter((x) => typeof x === "string").join("; "), true);
        const label = clip(m.label, 120);
        markers.push({ lat: mlat, lon: mlon, ...(label ? { label } : {}) });
      }
      const title = clip(i.title, 120);
      d.attachPart(ctx.conversationId, {
        type: "map",
        lat,
        lon,
        ...(zoom !== undefined ? { zoom } : {}),
        ...(title ? { title } : {}),
        ...(markers.length ? { markers } : {}),
      });
      return text(`The user now sees the map${title ? ` “${title}”` : ""} in the chat (and a location pin in Telegram, if your reply goes there).`);
    },
  );

  reg(
    {
      name: "vault_list",
      description: "List vault items (ids, names, types, non-secret hints). Never returns secret values. Pass `vault://<id>` to tools that accept secrets.",
      effect: "read",
      inputSchema: { type: "object", properties: {} },
    },
    () => {
      const items = d.vault.list();
      if (!items.length) return text("The vault is empty.");
      return text(
        `Vault: ${d.vault.state()}\n` +
          items.map((m) => `- vault://${m.id} (${m.type}) “${m.name}”${Object.keys(m.hints).length ? ` ${JSON.stringify(m.hints)}` : ""}${m.scope.revealToModel ? " [readable: vault_reveal]" : ""}`).join("\n"),
      );
    },
  );

  reg(
    {
      name: "vault_reveal",
      description: "Read the fields of a vault item that the user explicitly allowed to show to the model (revealToModel). Other items are refused.",
      effect: "read",
      inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
    },
    (i, ctx) => {
      const id = String(i.ref).replace(/^vault:\/\//, "");
      const meta = d.vault.getMeta(id);
      if (!meta) return text(`No vault item vault://${id}`, true);
      if (!meta.scope.revealToModel) return text("This item may not be shown to the model. Pass the vault:// reference to tools instead.", true);
      const fields = d.vault.access(id, { actor: `agent:${ctx.agentId}`, agentId: ctx.agentId, tool: "vault_reveal" });
      return text(JSON.stringify(fields, null, 2));
    },
  );
}
