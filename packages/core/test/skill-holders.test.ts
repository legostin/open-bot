// Skills of their own (docs/superpowers/specs/2026-10-31-skill-holders-design.md): a skill with no holders is the
// whole team's, one given to agents only theirs; a taught skill goes to the agent who learned it; any agent gives a
// skill to teammates in the chat; the dialog's team list says which teammate has which skill.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDef } from "@piomio/shared";
import { openDb } from "../src/db.ts";
import { hasSkill, SkillHolders, SkillIndex } from "../src/skills.ts";
import { buildSystemPrompt } from "../src/prompt.ts";

const agent = (id: string, skills: string[] = ["*"]) => ({ id, skills });

function index(names: string[]): SkillIndex {
  const dir = mkdtempSync(join(tmpdir(), "owl-holders-"));
  for (const n of names) {
    mkdirSync(join(dir, n));
    writeFileSync(join(dir, n, "SKILL.md"), `---\nname: ${n}\ndescription: ${n} things\n---\nDo ${n}.`);
  }
  const skills = new SkillIndex();
  skills.holders = new SkillHolders(openDb(":memory:"));
  skills.setRoots([{ source: "user", skillsDir: dir }]);
  return skills;
}

describe("who has a skill", () => {
  it("no holders: the whole team; holders: only them; an empty list gives it back to the team", () => {
    const h = new SkillHolders(openDb(":memory:"));
    expect(h.get("insta-post")).toEqual([]);
    h.set("insta-post", ["smm", "smm", "researcher"]);
    expect(h.get("insta-post")).toEqual(["smm", "researcher"]);
    expect([...h.all()]).toEqual([["insta-post", ["smm", "researcher"]]]);
    h.set("insta-post", []);
    expect(h.all().size).toBe(0);
  });

  it("an agent who leaves takes nobody's skill away: one only it had goes back to the team", () => {
    const h = new SkillHolders(openDb(":memory:"));
    h.set("insta-post", ["smm"]);
    h.set("web-search", ["smm", "researcher"]);
    h.dropAgent("smm");
    expect(h.get("insta-post")).toEqual([]);
    expect(h.get("web-search")).toEqual(["researcher"]);
  });

  it("an agent has a skill its patterns fit when it is the team's or was given to it", () => {
    expect(hasSkill(agent("smm"), "insta-post", [])).toBe(true);
    expect(hasSkill(agent("smm"), "insta-post", ["smm"])).toBe(true);
    expect(hasSkill(agent("researcher"), "insta-post", ["smm"])).toBe(false);
    expect(hasSkill(agent("smm", ["web-*"]), "insta-post", ["smm"])).toBe(false);
    expect(hasSkill(agent("smm", []), "insta-post", [])).toBe(true);
  });

  it("the index lists an agent's skills, its own ones, and a skill a run follows anyway", () => {
    const skills = index(["insta-post", "web-search", "notes"]);
    skills.holders!.set("insta-post", ["smm"]);
    skills.holders!.set("web-search", ["researcher", "smm"]);
    const names = (a: Pick<AgentDef, "id" | "skills">, also?: string) => skills.forAgent(a, also).map((s) => s.name);
    expect(names(agent("smm"))).toEqual(["insta-post", "notes", "web-search"]);
    expect(names(agent("researcher"))).toEqual(["notes", "web-search"]);
    expect(names(agent("researcher"), "insta-post")).toEqual(["insta-post", "notes", "web-search"]);
    expect(skills.has(agent("researcher"), "insta-post")).toBe(false);
    expect(skills.has(agent("researcher"), "insta-post", "insta-post")).toBe(true);
    expect(skills.ownOf("smm")).toEqual(["insta-post", "web-search"]);
    expect(skills.ownOf("assistant")).toEqual([]);
    // A row for a skill that is gone (its plugin removed) is not someone's skill.
    skills.holders!.set("gone", ["smm"]);
    expect(skills.ownOf("smm")).toEqual(["insta-post", "web-search"]);
  });
});

describe("what an agent is told", () => {
  const assistant = { id: "assistant", name: "Owl", description: "", brains: [], initiative: 1, tools: ["*"], skills: ["*"], policyProfile: "default", budget: { backgroundRunsPerDay: 5 }, prompt: "", source: "builtin" } as AgentDef;
  const base = { agent: assistant, timezone: "UTC", language: "en", consoleUrl: "http://x", background: false, nativeSkills: false, appended: [] };

  it("the dialog's team list says which teammate has which skill of its own, and to hand such work to them", () => {
    const skills = index(["insta-post", "notes"]);
    skills.holders!.set("insta-post", ["smm"]);
    const p = buildSystemPrompt({
      ...base,
      skills: skills.forAgent(assistant),
      dispatch: {
        team: [
          { id: "assistant", name: "Owl", description: "Helps", where: ["MacBook"], skills: [] },
          { id: "smm", name: "SMM", description: "Runs pages", where: ["MacBook"], skills: skills.ownOf("smm") },
        ],
        computers: [{ id: "local", name: "MacBook", online: true }],
      },
    });
    expect(p).toContain("- smm: SMM — Runs pages (skills: insta-post; on: MacBook)");
    expect(p).toContain("- assistant: Owl (you) — Helps (on: MacBook)");
    expect(p).toContain("work that needs one goes to them");
    // Its own Skills section lists only what it has.
    const section = p.slice(p.indexOf("## Skills"));
    expect(section).toContain("- notes: notes things");
    expect(section).not.toContain("insta-post");
  });
});
