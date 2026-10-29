// What a CLI brain's own tools may do without asking: Claude Code's Read/Write/Edit/Bash/…, Codex's commands and
// file changes. The brains run them in their own processes, outside the hub's tool gateway; the CLI asks the hub here
// (Claude Code through its permission prompt tool, Codex through its approval requests: tools/native-permission.ts).
// Inside the agent's own folder (and the temp folders) they just work; reading or writing elsewhere in the person's
// home, a command outside the sandbox, network from a command, and anything unknown wait for the person's yes on an
// approval card, like an external action. Outside the home (system files, tools) reading is fine. The person's
// credentials and the hub's own data (conversations, the vault, other agents' folders) are never theirs to read.
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export type NativeAction =
  | { kind: "read"; tool: string; path: string }
  | { kind: "write"; tool: string; path: string }
  /** A shell command the CLI wants to run outside its sandbox (a sandboxed one never comes here). */
  | { kind: "command"; tool: string; command: string; cwd?: string; reason?: string; network?: string }
  | { kind: "fetch"; tool: string; url?: string }
  | { kind: "free"; tool: string }
  | { kind: "other"; tool: string; input: unknown };

export interface NativeScope {
  /** The agent's own folder for this session. */
  workspace: string;
  /** More folders it may read and write in (temp folders are always in). */
  roots?: string[];
  /** Folders no tool of the brain may read or write, whatever the person says (see `confinement`). */
  denied?: string[];
  home?: string;
}

export interface NativeDecision {
  decision: "allow" | "ask" | "deny";
  /** English, for the audit log. */
  reason: string;
}

/** Tools with no reach of their own: planning, subagents (which ask again), skills, deferred tool lookup. */
const FREE = new Set(["TodoWrite", "Task", "Agent", "Skill", "ToolSearch", "ExitPlanMode", "EnterPlanMode", "KillShell", "BashOutput", "TaskOutput", "TaskStop"]);
/** The web through the CLI: outside content, which taints the session (runner.ts), but reaches nothing of the person's. */
const FETCH = new Set(["WebFetch", "WebSearch"]);
const READ = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const WRITE = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** A Claude Code tool call as an action. Paths are resolved against `cwd`. */
export function classifyClaudeTool(tool: string, input: unknown, cwd: string): NativeAction {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const at = (p: string | undefined) => (p ? resolve(cwd, expandHome(p)) : cwd);
  if (FREE.has(tool)) return { kind: "free", tool };
  if (FETCH.has(tool)) return { kind: "fetch", tool, url: str(i.url) };
  if (READ.has(tool)) return { kind: "read", tool, path: at(str(i.file_path) ?? str(i.notebook_path) ?? str(i.path)) };
  if (WRITE.has(tool)) return { kind: "write", tool, path: at(str(i.file_path) ?? str(i.notebook_path)) };
  if (tool === "Bash") return { kind: "command", tool, command: str(i.command) ?? "", cwd, reason: str(i.description) };
  return { kind: "other", tool, input };
}

function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** `p` is `dir` or inside it. */
export function within(p: string, dir: string): boolean {
  const rel = relative(normalize(dir), normalize(p));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

/** The temp folders a command may use (macOS keeps them under /private). */
function temps(): string[] {
  const t = tmpdir();
  return [t, "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].filter((d, n, all) => all.indexOf(d) === n);
}

export function decideNative(a: NativeAction, scope: NativeScope): NativeDecision {
  const home = scope.home ?? homedir();
  const own = [scope.workspace, ...(scope.roots ?? []), ...temps()];
  const mine = (p: string) => own.some((d) => within(p, d));
  // Only the agent's own folders open a denied one (the hub's data may well sit in a temp folder).
  const exempt = [scope.workspace, ...(scope.roots ?? [])];
  const denied = (p: string) => !exempt.some((d) => within(p, d)) && (scope.denied ?? []).some((d) => within(p, d));
  if ((a.kind === "read" || a.kind === "write") && denied(a.path)) return { decision: "deny", reason: "the person's credentials or the hub's own data" };
  switch (a.kind) {
    case "free":
      return { decision: "allow", reason: "no reach of its own" };
    case "fetch":
      return { decision: "allow", reason: "the web, through the hub's egress rules" };
    case "read":
      if (mine(a.path)) return { decision: "allow", reason: "inside the agent's folder" };
      // System files and tools are fine to read; the person's home is theirs.
      if (!within(a.path, home)) return { decision: "allow", reason: "outside the person's home" };
      return { decision: "ask", reason: "reads the person's files outside the agent's folder" };
    case "write":
      if (mine(a.path)) return { decision: "allow", reason: "inside the agent's folder" };
      return { decision: "ask", reason: "writes outside the agent's folder" };
    case "command":
      return { decision: "ask", reason: a.network ? `a command reaching ${a.network}` : "a command outside the sandbox" };
    case "other":
      return { decision: "ask", reason: `an unknown tool (${a.tool})` };
  }
}

/** The path a summary shows: relative to the home when it is inside it. */
export function shownPath(p: string, home = homedir()): string {
  return within(p, home) && p !== home ? `~${sep}${relative(home, p)}` : p;
}

/** Credentials and private stores in a home folder that no agent's tool reads (relative to the home). */
const PRIVATE = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".password-store",
  ".config/gh",
  ".config/gcloud",
  ".local/share/keyrings",
  ".codex",
  ".claude/.credentials.json",
  ".claude.json",
  "Library/Keychains",
  "Library/Cookies",
  "Library/Messages",
  "Library/Mail",
  "Library/Safari",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Firefox",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/Arc",
  "Library/Application Support/1Password",
  "Library/Application Support/com.apple.TCC",
  "Library/Group Containers/group.com.apple.notes",
];

/**
 * What a sandboxed brain may not read: the person's credentials and private stores, and the hub's data folder (its
 * conversations, vault, memory and the other agents' folders), except the session's own workspace and `allow`.
 */
export function confinement(dataDir: string, workspace: string, allow: string[] = [], home = homedir()): { denyRead: string[]; allowRead: string[] } {
  return { denyRead: [...PRIVATE.map((p) => join(home, p)), dataDir], allowRead: [workspace, ...allow.filter((d) => within(d, dataDir))] };
}
