import { parse as parseYaml } from "yaml";
import { randomBytes } from "node:crypto";
import type { BrainRef } from "./types.ts";

/** Split "---\nyaml\n---\nbody" into data + body. Missing frontmatter → empty data. */
export function parseFrontmatter(text: string): { data: Record<string, any>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = (parseYaml(m[1]) as Record<string, any>) ?? {};
  return { data, body: m[2] };
}

/** "claude-code@laptop", "api:anthropic", "api:openai@local" → BrainRef. */
export function parseBrainRef(ref: string): BrainRef {
  const [left, machine] = ref.split("@");
  const [brainId, variant] = left.split(":");
  return { brainId, variant: variant || undefined, machineId: machine || "local" };
}

export function formatBrainRef(r: BrainRef): string {
  return `${r.brainId}${r.variant ? ":" + r.variant : ""}@${r.machineId}`;
}

/** Glob with * (any chars) and ? (one char). */
export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

export function matchesAny(name: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(name));
}

/** Host pattern match: "*.github.com" matches "api.github.com" and "github.com"; "*" matches all. */
export function hostMatches(host: string, pattern: string): boolean {
  host = host.toLowerCase().replace(/\.$/, "");
  pattern = pattern.toLowerCase();
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return host === base || host.endsWith("." + base);
  }
  return host === pattern;
}

export function newId(prefix = ""): string {
  const t = Date.now().toString(36);
  const r = randomBytes(6).toString("base64url");
  return `${prefix}${t}${r}`.replace(/[^a-zA-Z0-9_]/g, "x");
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Fill "{field}" placeholders from an object; nested via dots. */
export function renderTemplate(tpl: string, input: unknown): string {
  return tpl.replace(/\{([a-zA-Z0-9_.]+)\}/g, (_, path: string) => {
    let v: any = input;
    for (const k of path.split(".")) v = v?.[k];
    if (v === undefined || v === null) return "";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 200 ? s.slice(0, 197) + "…" : s;
  });
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Extract hostname from a URL-ish string, or "" if not parseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}
