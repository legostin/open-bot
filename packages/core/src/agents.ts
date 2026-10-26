// Agents are markdown files with frontmatter (compatible with Claude Code subagent files).
// Sources, later wins: builtin (repo /agents) → plugin agents with `brains:` → user (/data/agents).

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { stringify as toYaml } from "yaml";
import type { AgentDef } from "@openbot/shared";
import { parseFrontmatter } from "@openbot/shared";

export const DEFAULT_BRAINS = ["claude-code@local", "codex@local", "api:anthropic", "api:openai"];

export function agentFromMarkdown(id: string, text: string, source: string): AgentDef {
  const { data, body } = parseFrontmatter(text);
  const list = (v: unknown, d: string[]): string[] =>
    Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : d;
  const initiative = Number(data.initiative ?? 1);
  return {
    id,
    name: String(data.name ?? id),
    description: String(data.description ?? ""),
    brains: list(data.brains, DEFAULT_BRAINS),
    model: data.model ? String(data.model) : undefined,
    initiative: (initiative === 0 || initiative === 2 ? initiative : 1) as 0 | 1 | 2,
    tools: list(data.tools, ["*"]),
    skills: list(data.skills, ["*"]),
    policyProfile: String(data.policyProfile ?? "default"),
    budget: {
      backgroundRunsPerDay: Number(data.budget?.backgroundRunsPerDay ?? 30),
      tokensPerDay: data.budget?.tokensPerDay ? Number(data.budget.tokensPerDay) : undefined,
    },
    prompt: body.trim(),
    source,
  };
}

export function agentToMarkdown(a: AgentDef): string {
  const fm: Record<string, unknown> = {
    name: a.name,
    description: a.description,
    brains: a.brains,
    ...(a.model ? { model: a.model } : {}),
    initiative: a.initiative,
    tools: a.tools,
    skills: a.skills,
    policyProfile: a.policyProfile,
    budget: a.budget,
  };
  return `---\n${toYaml(fm).trim()}\n---\n${a.prompt.trim()}\n`;
}

export class AgentRegistry {
  private agents = new Map<string, AgentDef>();
  builtinDir: string;
  userDir: string;
  pluginDirs: Array<{ pluginId: string; dir: string }> = [];

  constructor(builtinDir: string, userDir: string) {
    this.builtinDir = builtinDir;
    this.userDir = userDir;
    mkdirSync(userDir, { recursive: true });
    this.reload();
  }

  private loadDir(dir: string, source: string, requireBrains: boolean): void {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const id = basename(f, ".md").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      try {
        const text = readFileSync(join(dir, f), "utf8");
        if (requireBrains && parseFrontmatter(text).data.brains === undefined) continue;
        this.agents.set(id, agentFromMarkdown(id, text, source));
      } catch (e) {
        console.error(`[agents] failed to load ${f}:`, (e as Error).message);
      }
    }
  }

  reload(): void {
    this.agents.clear();
    this.loadDir(this.builtinDir, "builtin", false);
    for (const p of this.pluginDirs) this.loadDir(p.dir, `plugin:${p.pluginId}`, true);
    this.loadDir(this.userDir, "user", false);
    if (!this.agents.has("assistant")) {
      this.agents.set(
        "assistant",
        agentFromMarkdown("assistant", "---\nname: Ассистент\ndescription: Главный ассистент\n---\nТы — дружелюбный и проактивный персональный ассистент.", "builtin"),
      );
    }
  }

  get(id: string): AgentDef | undefined {
    return this.agents.get(id);
  }

  list(): AgentDef[] {
    return [...this.agents.values()].sort((a, b) => (a.id === "assistant" ? -1 : b.id === "assistant" ? 1 : a.name.localeCompare(b.name)));
  }

  save(a: AgentDef): AgentDef {
    const id = a.id.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    writeFileSync(join(this.userDir, `${id}.md`), agentToMarkdown({ ...a, id }));
    this.reload();
    return this.get(id)!;
  }

  remove(id: string): void {
    const f = join(this.userDir, `${id}.md`);
    if (existsSync(f)) rmSync(f);
    this.reload();
  }
}
