// What file replication leaves out (spec 2026-10-30-cluster-design.md, "2. Replicas → Files"): build output and
// dependency folders, OS junk, SQLite side files, the engine's own temp files, and what a .gitignore in the root or
// any folder above a path leaves out. `.git` folders sync. Pure: .gitignore texts come from a callback.

/** Folders never synced, wherever they are. */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  "node_modules", "vendor", ".venv", "venv", "target", "dist", "build", ".next", ".nuxt", ".cache", "__pycache__", ".gradle",
]);
/** Files never synced, wherever they are. */
export const IGNORED_FILES: ReadonlySet<string> = new Set([".DS_Store", "Thumbs.db"]);
/** SQLite's side files: a database travels as one consistent copy, never with these. */
export const SQLITE_SIDE = ["-wal", "-shm", "-journal"] as const;
/** The engine's temp files (atomic writes) start with this. */
export const TEMP_PREFIX = ".owlsync-";

/** A name left out by the built-in rules (no .gitignore involved). */
export function ignoredName(name: string, isDir: boolean): boolean {
  if (isDir) return IGNORED_DIRS.has(name);
  return IGNORED_FILES.has(name) || name.startsWith(TEMP_PREFIX) || SQLITE_SIDE.some((s) => name.endsWith(s));
}

export interface IgnoreRule {
  negate: boolean;
  dirOnly: boolean;
  /** no slash in the pattern: matches the last name at any depth below the .gitignore */
  basename: boolean;
  re: RegExp;
}

/** The rules of one .gitignore: blank and # lines, `name`, `dir/`, `*.ext`, `/anchored`, `**`, `?`, `[a-z]`, `!` negation. */
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (let line of text.split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    // Trailing spaces go unless escaped.
    line = line.replace(/(?<!\\)[ \t]+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    while (line.endsWith("/") && !line.endsWith("\\/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (!line) continue;
    let anchored = line.includes("/");
    if (line.startsWith("/")) {
      anchored = true;
      line = line.replace(/^\/+/, "");
    }
    if (!line) continue;
    rules.push({ negate, dirOnly, basename: !anchored, re: globToRegExp(line) });
  }
  return rules;
}

/** The last rule matching `rel` (posix, relative to the .gitignore's folder) decides; undefined when none matches. */
export function matchGitignore(rules: readonly IgnoreRule[], rel: string, isDir: boolean): boolean | undefined {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i];
    if (r.dirOnly && !isDir) continue;
    if (r.re.test(r.basename ? name : rel)) return !r.negate;
  }
  return undefined;
}

function globToRegExp(p: string): RegExp {
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*" && (i === 0 || p[i - 1] === "/") && (i + 2 === p.length || p[i + 2] === "/")) {
        if (i + 2 === p.length) {
          re += ".*"; // "a/**": everything inside
          i += 1;
        } else {
          re += "(?:.*/)?"; // "**/": any number of folders
          i += 2;
        }
        continue;
      }
      while (p[i + 1] === "*") i++; // other runs of asterisks are one asterisk
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      let j = i + 1;
      if (p[j] === "!" || p[j] === "^") j++;
      if (p[j] === "]") j++;
      while (j < p.length && p[j] !== "]") j++;
      if (j >= p.length) {
        re += "\\[";
        continue;
      }
      let body = p.slice(i + 1, j);
      const neg = body.startsWith("!") || body.startsWith("^");
      if (neg) body = body.slice(1);
      body = body.replace(/\\(.)/g, "$1").replace(/[\\\]\[^]/g, "\\$&");
      re += neg ? `[^/${body}]` : `[${body}]`;
      i = j;
    } else if (c === "\\" && i + 1 < p.length) {
      re += escapeRe(p[++i]);
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp(`^${re}$`);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Decides for paths of one root. `read(dir)` returns the text of `<dir>/.gitignore` ("" is the root itself), or
 * undefined when there is none; each folder is read once per Ignore, so make a new one to see edited .gitignore files.
 */
export class Ignore {
  private readonly read: (dir: string) => string | undefined;
  private readonly cache = new Map<string, IgnoreRule[] | null>();

  constructor(read: (dir: string) => string | undefined) {
    this.read = read;
  }

  /** `rel` itself or one of the folders above it is left out. */
  ignored(rel: string, isDir: boolean): boolean {
    const parts = rel.split("/");
    for (let i = 0; i < parts.length; i++) {
      if (this.entryIgnored(parts.slice(0, i + 1), i < parts.length - 1 || isDir)) return true;
    }
    return false;
  }

  /** Only the last name of `parts` (the folders above are known to be in). */
  entryIgnored(parts: readonly string[], isDir: boolean): boolean {
    const name = parts[parts.length - 1];
    if (ignoredName(name, isDir)) return true;
    let out = false;
    for (let k = 0; k < parts.length; k++) {
      const rules = this.rules(parts.slice(0, k).join("/"));
      if (!rules) continue;
      const m = matchGitignore(rules, parts.slice(k).join("/"), isDir);
      if (m !== undefined) out = m;
    }
    return out;
  }

  private rules(dir: string): IgnoreRule[] | null {
    let r = this.cache.get(dir);
    if (r === undefined) {
      const text = this.read(dir);
      r = text === undefined ? null : parseGitignore(text);
      this.cache.set(dir, r);
    }
    return r;
  }
}
