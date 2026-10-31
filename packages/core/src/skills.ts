// Agent Skills (folders with SKILL.md) and slash commands (commands/*.md).

import { readdirSync, readFileSync, existsSync, mkdirSync, cpSync, statSync, rmSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { matchesAny, parseFrontmatter } from "@piomio/shared";

export interface Skill {
  name: string;
  description: string;
  dir: string;
  source: string;
}

export interface Command {
  name: string;
  description: string;
  body: string;
  source: string;
}

export class SkillIndex {
  private skills = new Map<string, Skill>();
  private commands = new Map<string, Command>();
  roots: Array<{ source: string; skillsDir?: string; commandsDir?: string }> = [];

  setRoots(roots: Array<{ source: string; skillsDir?: string; commandsDir?: string }>): void {
    this.roots = roots;
    this.reload();
  }

  reload(): void {
    this.skills.clear();
    this.commands.clear();
    for (const r of this.roots) {
      if (r.skillsDir && existsSync(r.skillsDir)) {
        for (const d of readdirSync(r.skillsDir)) {
          const dir = join(r.skillsDir, d);
          const file = join(dir, "SKILL.md");
          if (!existsSync(file)) continue;
          try {
            const { data } = parseFrontmatter(readFileSync(file, "utf8"));
            const name = String(data.name ?? d);
            this.skills.set(name, { name, description: String(data.description ?? ""), dir, source: r.source });
          } catch (e) {
            console.error(`[skills] bad SKILL.md in ${dir}:`, (e as Error).message);
          }
        }
      }
      if (r.commandsDir && existsSync(r.commandsDir)) {
        for (const f of readdirSync(r.commandsDir)) {
          if (!f.endsWith(".md")) continue;
          const { data, body } = parseFrontmatter(readFileSync(join(r.commandsDir, f), "utf8"));
          const name = basename(f, ".md");
          this.commands.set(name, { name, description: String(data.description ?? ""), body, source: r.source });
        }
      }
    }
  }

  list(): Skill[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  forAgent(globs: string[]): Skill[] {
    return this.list().filter((s) => matchesAny(s.name, globs.length ? globs : ["*"]));
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** SKILL.md plus a listing of bundled files. */
  load(name: string): string | undefined {
    const s = this.skills.get(name);
    if (!s) return undefined;
    const body = readFileSync(join(s.dir, "SKILL.md"), "utf8");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (f !== "SKILL.md") files.push(relative(s.dir, p).replace(/\\/g, "/"));
      }
    };
    walk(s.dir);
    return `${body}\n\n---\nSkill files (directory ${s.dir}):\n${files.map((f) => `- ${f}`).join("\n") || "(none)"}`;
  }

  /** Copy enabled skills into a workspace folder the harness reads (e.g. .claude/skills). */
  materialize(targetDir: string, skills: Skill[]): void {
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(targetDir, { recursive: true });
    for (const s of skills) cpSync(s.dir, join(targetDir, s.name.replace(/[^a-zA-Z0-9_-]/g, "-")), { recursive: true });
  }

  listCommands(): Command[] {
    return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** "/name args" → prompt text, or undefined if not a known command. */
  expandCommand(text: string): string | undefined {
    const m = /^\/([a-zA-Z0-9_:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (!m) return undefined;
    const cmd = this.commands.get(m[1]);
    if (!cmd) return undefined;
    const args = (m[2] ?? "").trim();
    const positional = args.split(/\s+/);
    let body = cmd.body.replace(/\$ARGUMENTS/g, args);
    body = body.replace(/\$(\d)/g, (_, n: string) => positional[Number(n) - 1] ?? "");
    return body.trim();
  }
}
