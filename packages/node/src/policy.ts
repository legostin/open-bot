// Local policy: the machine owner (not the hub) decides which folders, commands and brains are available.
// ~/.openbot-node/policy.json is created with safe defaults on first run and re-read whenever it changes.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ensureHome, policyFile, UserError } from "./home.ts";

export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export interface Policy {
  /** Every fs.* path and exec cwd must resolve inside one of these. */
  allowedDirs: string[];
  exec: {
    enabled: boolean;
    /** Command globs (`*`, `?`). Empty or missing = any command. */
    allowCommands?: string[];
    /** Shell for exec.run (default: /bin/sh, cmd.exe on Windows). */
    shell?: string;
    /** Upper bound for a single command (ms). */
    maxTimeoutMs?: number;
  };
  fs: { read: boolean; write: boolean };
  brains: {
    "claude-code": { enabled: boolean; command?: string; allowedTools: string[] };
    codex: { enabled: boolean; command?: string; sandbox: CodexSandbox };
  };
  /** Brain sessions run in <workspacesRoot>/<agent>/<task-or-conversation>. */
  workspacesRoot: string;
}

/** Claude Code built-in tools allowed by default: file tools and web, but no Bash. */
export const DEFAULT_NODE_CLAUDE_TOOLS = ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite", "Task", "Skill", "mcp__openbot"];

export const DEFAULT_MAX_TIMEOUT_MS = 30 * 60_000;

export function defaultPolicy(userHome = homedir()): Policy {
  const ws = join(userHome, "openbot-workspace");
  return {
    allowedDirs: [ws],
    exec: { enabled: false, allowCommands: [] },
    fs: { read: true, write: true },
    brains: {
      "claude-code": { enabled: true, allowedTools: [...DEFAULT_NODE_CLAUDE_TOOLS] },
      codex: { enabled: true, sandbox: "workspace-write" },
    },
    workspacesRoot: ws,
  };
}

const SANDBOXES: CodexSandbox[] = ["read-only", "workspace-write", "danger-full-access"];

function expandPath(p: unknown, userHome: string, field: string): string {
  if (typeof p !== "string" || !p.trim()) throw new Error(`${field}: ожидается непустая строка с путём`);
  let s = p.trim();
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) s = join(userHome, s.slice(1));
  if (!isAbsolute(s)) throw new Error(`${field}: путь должен быть абсолютным (или начинаться с ~): ${p}`);
  return resolve(s);
}

const bool = (v: unknown, d: boolean, field: string): boolean => {
  if (v === undefined) return d;
  if (typeof v !== "boolean") throw new Error(`${field}: ожидается true или false`);
  return v;
};

const strList = (v: unknown, field: string): string[] | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`${field}: ожидается массив строк`);
  return v as string[];
};

/** Fills missing fields with defaults, expands ~ and validates types. Throws a readable error. */
export function normalizePolicy(raw: any, userHome = homedir()): Policy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("ожидается JSON-объект");
  const d = defaultPolicy(userHome);
  const allowedDirs = raw.allowedDirs === undefined ? d.allowedDirs : (strList(raw.allowedDirs, "allowedDirs") ?? []).map((p, i) => expandPath(p, userHome, `allowedDirs[${i}]`));
  const exec = raw.exec ?? {};
  const fs = raw.fs ?? {};
  const brains = raw.brains ?? {};
  const cc = brains["claude-code"] ?? {};
  const cx = brains.codex ?? {};
  const sandbox = cx.sandbox ?? d.brains.codex.sandbox;
  if (!SANDBOXES.includes(sandbox)) throw new Error(`brains.codex.sandbox: одно из ${SANDBOXES.join(", ")}`);
  const maxTimeoutMs = exec.maxTimeoutMs === undefined ? undefined : Number(exec.maxTimeoutMs);
  if (maxTimeoutMs !== undefined && !(maxTimeoutMs > 0)) throw new Error("exec.maxTimeoutMs: ожидается положительное число");
  const command = (v: unknown, field: string) => {
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string") throw new Error(`${field}: ожидается строка`);
    return v.startsWith("~") ? expandPath(v, userHome, field) : v;
  };
  return {
    allowedDirs,
    exec: {
      enabled: bool(exec.enabled, false, "exec.enabled"),
      allowCommands: strList(exec.allowCommands, "exec.allowCommands") ?? [],
      ...(exec.shell ? { shell: String(exec.shell) } : {}),
      ...(maxTimeoutMs ? { maxTimeoutMs } : {}),
    },
    fs: { read: bool(fs.read, true, "fs.read"), write: bool(fs.write, true, "fs.write") },
    brains: {
      "claude-code": {
        enabled: bool(cc.enabled, true, "brains.claude-code.enabled"),
        ...(command(cc.command, "brains.claude-code.command") ? { command: command(cc.command, "brains.claude-code.command") } : {}),
        allowedTools: strList(cc.allowedTools, "brains.claude-code.allowedTools") ?? [...DEFAULT_NODE_CLAUDE_TOOLS],
      },
      codex: {
        enabled: bool(cx.enabled, true, "brains.codex.enabled"),
        ...(command(cx.command, "brains.codex.command") ? { command: command(cx.command, "brains.codex.command") } : {}),
        sandbox,
      },
    },
    workspacesRoot: raw.workspacesRoot === undefined ? (allowedDirs[0] ?? d.workspacesRoot) : expandPath(raw.workspacesRoot, userHome, "workspacesRoot"),
  };
}

/** Holds the current policy; re-reads the file when its mtime/size changes. A broken edit keeps the last good policy. */
export class PolicyStore {
  readonly file: string;
  readonly userHome: string;
  private current: Policy;
  private stamp = "";
  private listeners: Array<(p: Policy) => void> = [];
  private log: (msg: string) => void;
  private lastError?: string;

  constructor(home: string, opts: { userHome?: string; log?: (msg: string) => void } = {}) {
    this.file = policyFile(home);
    this.userHome = opts.userHome ?? homedir();
    this.log = opts.log ?? (() => {});
    if (!existsSync(this.file)) {
      ensureHome(home);
      const p = defaultPolicy(this.userHome);
      writeFileSync(this.file, JSON.stringify(p, null, 2) + "\n", { mode: 0o600 });
      this.log(`создан файл политики с безопасными настройками: ${this.file}`);
    }
    this.current = this.read(true)!;
    try {
      mkdirSync(this.current.workspacesRoot, { recursive: true });
    } catch (e: any) {
      this.log(`не удалось создать ${this.current.workspacesRoot}: ${e.message}`);
    }
  }

  private statStamp(): string {
    try {
      const s = statSync(this.file);
      return `${s.mtimeMs}:${s.size}:${s.ino}`;
    } catch {
      return "missing";
    }
  }

  private read(initial: boolean): Policy | undefined {
    const stamp = this.statStamp();
    try {
      const p = normalizePolicy(JSON.parse(readFileSync(this.file, "utf8")), this.userHome);
      this.stamp = stamp;
      this.lastError = undefined;
      return p;
    } catch (e: any) {
      const msg = `ошибка в ${this.file}: ${e.message}`;
      if (initial) throw new UserError(`Ошибка в ${this.file}: ${e.message}`);
      this.stamp = stamp;
      if (msg !== this.lastError) this.log(`${msg} — продолжаю с предыдущей политикой`);
      this.lastError = msg;
      return undefined;
    }
  }

  /** Current policy (re-reads the file if it changed since the last call). */
  get(): Policy {
    if (this.statStamp() !== this.stamp) {
      const p = this.read(false);
      if (p && JSON.stringify(p) !== JSON.stringify(this.current)) {
        this.current = p;
        this.log("политика перечитана");
        for (const cb of this.listeners) {
          try {
            cb(p);
          } catch {
            /* ignore */
          }
        }
      }
    }
    return this.current;
  }

  onChange(cb: (p: Policy) => void): void {
    this.listeners.push(cb);
  }

  /** Poll the file so changes are noticed even without requests. Returns a stop function. */
  watch(intervalMs = 2000): () => void {
    const t = setInterval(() => this.get(), intervalMs);
    t.unref();
    return () => clearInterval(t);
  }
}

export function policySummary(p: Policy): string[] {
  const cc = p.brains["claude-code"];
  return [
    `Разрешённые папки: ${p.allowedDirs.length ? p.allowedDirs.join(", ") : "нет"}`,
    `Рабочие папки мозгов: ${p.workspacesRoot}`,
    `Файлы: чтение ${p.fs.read ? "да" : "нет"}, запись ${p.fs.write ? "да" : "нет"}`,
    `Команды: ${p.exec.enabled ? (p.exec.allowCommands?.length ? `только ${p.exec.allowCommands.join(", ")}` : "любые") : "запрещены"}`,
    `Claude Code: ${cc.enabled ? `включён, инструменты: ${cc.allowedTools.join(", ")}` : "отключён"}`,
    `Codex: ${p.brains.codex.enabled ? `включён, песочница ${p.brains.codex.sandbox}` : "отключён"}`,
  ];
}
