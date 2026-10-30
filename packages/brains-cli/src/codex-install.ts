// Which Codex to run. Codex's servers offer newer models only to newer clients, so an npm install left behind sees an
// older line-up (GPT-6 Astra and GPT-5.6, where the copy the ChatGPT app carries also has GPT-6.1 Sol, Terra and GPT-6
// Luna). Unless a setting names one, the newest of the Codex on PATH and the apps' copies runs.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the ChatGPT and Codex apps keep the Codex they run (macOS): their `codex-cli` folder. */
export const APP_CODEX_ROOTS = ["ChatGPT.app", "Codex.app"].flatMap((app) =>
  ["/Applications", join(homedir(), "Applications")].map((dir) => join(dir, app, "Contents", "Resources", "codex-cli")),
);

function versionOf(text: string): { parts: number[]; pre: boolean } | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)(-[\w.]+)?/.exec(text);
  return m ? { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: !!m[4] } : undefined;
}

/** Positive when version text `a` is newer than `b` ("codex-cli 0.165.0-alpha.1.2" vs "0.153.4"); unknown is oldest. */
export function compareVersions(a: string | undefined, b: string | undefined): number {
  const pa = versionOf(a ?? "");
  const pb = versionOf(b ?? "");
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] - pb.parts[i];
  return (pb.pre ? 1 : 0) - (pa.pre ? 1 : 0);
}

/** The Codex copies the apps carry, with their versions (`codex-package.json` names the entry point). */
export function appCodexes(roots: string[] = APP_CODEX_ROOTS): Array<{ command: string; version: string }> {
  const out: Array<{ command: string; version: string }> = [];
  for (const root of roots) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, "codex-package.json"), "utf8"));
      const entry = typeof pkg.entrypoint === "string" && /^[\w-]+(\/[\w.-]+)*$/.test(pkg.entrypoint) && !pkg.entrypoint.includes("..") ? pkg.entrypoint : "bin/codex";
      const command = join(root, entry);
      if (typeof pkg.version === "string" && existsSync(command)) out.push({ command, version: pkg.version });
    } catch {
      // Not installed here.
    }
  }
  return out;
}

/** The newest of the Codex on PATH (`onPath`) and the apps' copies. */
export function newestCodex(onPath: string, apps = appCodexes()): string {
  if (!apps.length) return onPath;
  let version: string | undefined;
  try {
    version = execFileSync(onPath, ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    version = undefined;
  }
  let best: { command: string; version: string | undefined } = { command: onPath, version };
  for (const a of apps) if (compareVersions(a.version, best.version) > 0) best = a;
  return best.command;
}

/**
 * The Codex to run for a setting: the command it names, or for none (or the default "codex") the newest on this
 * machine on macOS, asked again every ten minutes.
 */
export function codexChooser(platform: string = process.platform): (named?: string) => string {
  let chosen: { at: number; command: string } | undefined;
  return (named) => {
    if (named && named !== "codex") return named;
    if (platform !== "darwin") return "codex";
    if (!chosen || Date.now() - chosen.at > 10 * 60_000) chosen = { at: Date.now(), command: newestCodex("codex") };
    return chosen.command;
  };
}
