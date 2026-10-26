// Plugin manifests: our .openbot-plugin/plugin.json plus Claude Code and Codex formats.

import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { LOCALES, type Catalog } from "./i18n.ts";

const relPath = z
  .string()
  .refine((p) => p.startsWith("./") && !p.split(/[\\/]/).includes(".."), "path must start with ./ and stay inside the plugin");

export const PluginPermissionsSchema = z
  .object({
    /** Hostname patterns for egress, "*" = any. */
    network: z.array(z.string()).default([]),
    /** Vault item ids or "<type>:*" (e.g. "login:*" — still limited by each item's scope). */
    vault: z.array(z.string()).default([]),
    /** Core API methods this plugin may call (see CORE_METHODS). */
    core: z.array(z.string()).default([]),
    /** UI capabilities, informational for the install dialog. */
    ui: z.array(z.string()).default([]),
    /** Extra filesystem paths (informational; enforced by unix users in Docker). */
    fs: z.array(z.string()).default([]),
  })
  .default({ network: [], vault: [], core: [], ui: [], fs: [] });

export const OpenbotManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, "id: lowercase letters, digits, dashes"),
  name: z.string().min(1),
  version: z.string().default("0.0.0"),
  description: z.string().default(""),
  author: z.string().optional(),
  server: relPath.optional(),
  ui: relPath.optional(),
  /** Tool-name prefix; defaults to id with dashes replaced by underscores. */
  toolPrefix: z.string().regex(/^[a-zA-Z0-9_]+$/).optional(),
  contributes: z
    .object({
      tools: z.boolean().default(false),
      brains: z.array(z.string()).default([]),
      channels: z.array(z.string()).default([]),
      triggers: z.array(z.string()).default([]),
      hooks: z.array(z.string()).default([]),
      http: z.boolean().default(false),
      /** JSON Schema for plugin settings, rendered as a form in the web UI. */
      settings: z.record(z.string(), z.unknown()).optional(),
    })
    .default({ tools: false, brains: [], channels: [], triggers: [], hooks: [], http: false }),
  permissions: PluginPermissionsSchema,
  /** Built-in plugins start enabled; third-party ones need confirmation. */
  builtin: z.boolean().default(false),
});

export type OpenbotManifest = z.infer<typeof OpenbotManifestSchema>;
export type PluginPermissions = z.infer<typeof PluginPermissionsSchema>;

/** Core methods a plugin can be granted via permissions.core. */
export const CORE_METHODS = [
  "conversations.post", // post a message into a conversation
  "channels.inbound", // a user message arrived via a channel
  "tasks.create",
  "tasks.get",
  "tasks.list",
  "notify",
  "approvals.resolve",
  "settings.get",
  "agents.list",
  "ui.emit", // push a plugin event to web clients
  "vault.check", // check if a vault ref exists / is unlocked (metadata only)
  "machines.list",
  "notifications.feedback", // apply a signed feedback button press (useful / less / off)
  "files.deliver", // write a file (in base64 chunks) into a session workspace's downloads/ folder
] as const;
export type CoreMethod = (typeof CORE_METHODS)[number];

export interface PluginLayout {
  dir: string;
  /** Which manifests exist. */
  formats: Array<"openbot" | "claude" | "codex">;
  manifest: OpenbotManifest;
  serverEntry?: string;
  uiEntry?: string;
  skillsDir?: string;
  commandsDir?: string;
  agentsDir?: string;
  hooksFile?: string;
  mcpFile?: string;
  /** Translations from .openbot-plugin/locales/<locale>.json: "%key%" strings in the manifest, ctx.i18n, ui.i18n. */
  messages: Catalog;
}

/** Flat key → string maps from .openbot-plugin/locales/<locale>.json; malformed files are rejected. */
export function readPluginMessages(dir: string): Catalog {
  const out: Catalog = {};
  for (const locale of LOCALES) {
    const file = join(dir, ".openbot-plugin", "locales", `${locale}.json`);
    if (!existsSync(file)) continue;
    const parsed = z.record(z.string(), z.string()).safeParse(readJson(file));
    if (!parsed.success) throw new Error(`invalid .openbot-plugin/locales/${locale}.json: expected a flat object of strings`);
    out[locale] = parsed.data;
  }
  return out;
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

function inside(dir: string, p: string): string {
  const abs = resolve(dir, p);
  const rel = relative(dir, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path escapes plugin dir: ${p}`);
  return abs;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^([^a-z])/, "p-$1")
      .slice(0, 40) || "plugin"
  );
}

/** Read a plugin directory in any supported format. Throws with a readable message on invalid manifests. */
export function readPluginLayout(dir: string): PluginLayout {
  const formats: PluginLayout["formats"] = [];
  const ob = join(dir, ".openbot-plugin", "plugin.json");
  const cl = join(dir, ".claude-plugin", "plugin.json");
  const cx = join(dir, ".codex-plugin", "plugin.json");
  let manifest: OpenbotManifest | undefined;
  let foreign: any;

  if (existsSync(ob)) {
    formats.push("openbot");
    const parsed = OpenbotManifestSchema.safeParse(readJson(ob));
    if (!parsed.success) throw new Error(`invalid .openbot-plugin/plugin.json: ${parsed.error.message}`);
    manifest = parsed.data;
  }
  if (existsSync(cl)) {
    formats.push("claude");
    foreign ??= readJson(cl);
  }
  if (existsSync(cx)) {
    formats.push("codex");
    foreign ??= readJson(cx);
  }
  if (!manifest) {
    if (!foreign) throw new Error("no plugin manifest found (.openbot-plugin, .claude-plugin or .codex-plugin)");
    manifest = OpenbotManifestSchema.parse({
      id: slug(String(foreign.name ?? "plugin")),
      name: String(foreign.name ?? "plugin"),
      version: String(foreign.version ?? "0.0.0"),
      description: String(foreign.description ?? ""),
      author: typeof foreign.author === "string" ? foreign.author : foreign.author?.name,
    });
  }

  const pick = (p: string) => (existsSync(join(dir, p)) ? join(dir, p) : undefined);
  // Foreign manifests may point at custom dirs ("skills": "./skills/", "mcpServers": "./.mcp.json").
  const foreignSkills = typeof foreign?.skills === "string" ? inside(dir, foreign.skills) : undefined;
  const foreignMcp = typeof foreign?.mcpServers === "string" ? inside(dir, foreign.mcpServers) : undefined;

  return {
    dir,
    formats,
    manifest,
    serverEntry: manifest.server ? inside(dir, manifest.server) : undefined,
    uiEntry: manifest.ui ? inside(dir, manifest.ui) : undefined,
    skillsDir: foreignSkills && existsSync(foreignSkills) ? foreignSkills : pick("skills"),
    commandsDir: pick("commands"),
    agentsDir: pick("agents"),
    hooksFile: pick(join("hooks", "hooks.json")),
    mcpFile: foreignMcp && existsSync(foreignMcp) ? foreignMcp : pick(".mcp.json"),
    messages: readPluginMessages(dir),
  };
}

export function toolPrefixOf(m: OpenbotManifest): string {
  return m.toolPrefix ?? m.id.replace(/-/g, "_");
}
