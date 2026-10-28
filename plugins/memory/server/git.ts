// Optional git versioning of the memory folder. Failures are logged, never thrown.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const AUTHOR = "Owlbot <memory@owlbot.local>";
const CONFIG = [
  "-c", "user.name=Owlbot",
  "-c", "user.email=memory@owlbot.local",
  "-c", "commit.gpgsign=false",
  "-c", "core.autocrlf=false",
  "-c", "core.quotepath=false",
  "-c", "safe.directory=*",
];

export class GitRepo {
  dir: string;
  enabled = false;
  private warn: (msg: string) => void;

  constructor(dir: string, warn: (msg: string) => void) {
    this.dir = dir;
    this.warn = warn;
  }

  private run(args: string[]): Promise<string> {
    // Inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE (e.g. when started from a git hook) would point git elsewhere.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_OPTIONAL_LOCKS = "0";
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        [...CONFIG, ...args],
        { cwd: this.dir, timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env },
        (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout))),
      );
    });
  }

  /** Detect git and make the memory folder a repository. */
  async init(): Promise<void> {
    try {
      await this.run(["--version"]);
    } catch {
      return; // git not installed: memory works without history
    }
    try {
      if (!existsSync(join(this.dir, ".git"))) await this.run(["init", "-q"]);
      this.enabled = true;
    } catch (e: any) {
      this.warn(`git init failed, memory history is disabled: ${e.message}`);
    }
  }

  /** Stage everything and commit if anything changed. Returns true when a commit was made. */
  async commit(message: string): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      await this.run(["add", "-A", "."]);
      if (!(await this.run(["status", "--porcelain"])).trim()) return false;
      await this.run(["commit", "-q", "--author", AUTHOR, "-m", message]);
      return true;
    } catch (e: any) {
      this.warn(`git commit failed (${message}): ${e.message}`);
      return false;
    }
  }

  /** Versions of one file, newest first: short hash, author time, subject. */
  async history(path: string, limit = 30): Promise<Array<{ rev: string; at: string; message: string }>> {
    if (!this.enabled) return [];
    try {
      const out = await this.run(["log", `-${limit}`, "--format=%h%x09%aI%x09%s", "--", path]);
      return out
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [rev, at, ...msg] = l.split("\t");
          return { rev, at, message: msg.join("\t") };
        });
    } catch {
      return [];
    }
  }

  /** A file's text at a version, or undefined. */
  async show(rev: string, path: string): Promise<string | undefined> {
    if (!this.enabled || !/^[0-9a-f]{4,40}$/i.test(rev)) return undefined;
    try {
      return await this.run(["show", `${rev}:${path}`]);
    } catch {
      return undefined;
    }
  }

  async log(limit = 20): Promise<string[]> {
    if (!this.enabled) return [];
    try {
      return (await this.run(["log", `-${limit}`, "--format=%s"])).split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }
}
