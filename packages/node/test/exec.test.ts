import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePolicy, type Policy } from "../src/policy.ts";
import { ExecDenied, checkCommand, execRun } from "../src/exec.ts";
import { PathDenied } from "../src/guard.ts";

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "obn-exec-")));
const allowed = join(root, "allowed");
const outside = join(root, "outside");
mkdirSync(allowed, { recursive: true });
mkdirSync(outside, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const policy = (exec: Record<string, unknown>): Policy => normalizePolicy({ allowedDirs: [allowed], exec }, root);
const node = `"${process.execPath}"`;
/** `node -e <script>` as a shell command; the script must not contain double quotes. */
const nodeCmd = (script: string) => `${node} -e "${script}"`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("exec policy", () => {
  it("is refused while exec is disabled", async () => {
    await expect(execRun({ command: nodeCmd("1") }, policy({ enabled: false }), {})).rejects.toThrow(/exec.enabled = false/);
    await expect(execRun({ command: nodeCmd("1") }, normalizePolicy({ allowedDirs: [allowed] }, root), {})).rejects.toBeInstanceOf(ExecDenied);
  });

  it("checks the allowlist and refuses shell chaining when one is set", () => {
    const p = policy({ enabled: true, allowCommands: ["git status", "npm test*"] });
    expect(checkCommand("git status", p)).toBe("git status");
    expect(checkCommand("npm test -- --run", p)).toBe("npm test -- --run");
    expect(() => checkCommand("rm -rf /", p)).toThrow(/allowCommands/);
    expect(() => checkCommand("git status; rm -rf /", p)).toThrow(/are not allowed/);
    expect(() => checkCommand("git status && whoami", p)).toThrow(ExecDenied);
    expect(() => checkCommand("npm test $(whoami)", p)).toThrow(ExecDenied);
    expect(() => checkCommand("npm test\nwhoami", p)).toThrow(ExecDenied);
    expect(() => checkCommand("", p)).toThrow(/No command/);
    // No allowlist: any command, chaining included.
    expect(checkCommand("echo a && echo b", policy({ enabled: true }))).toBe("echo a && echo b");
  });

  it("keeps cwd inside the allowed dirs", async () => {
    const p = policy({ enabled: true });
    await expect(execRun({ command: nodeCmd("1"), cwd: outside }, p, {})).rejects.toBeInstanceOf(PathDenied);
    await expect(execRun({ command: nodeCmd("1"), cwd: join(allowed, "nope") }, p, {})).rejects.toThrow(/does not exist/);
  });
});

describe("exec.run", () => {
  const p = policy({ enabled: true });

  it("runs a command in the first allowed dir by default and returns code/stdout/stderr", async () => {
    const r = await execRun({ command: nodeCmd("console.log(process.cwd()); console.error('warn'); console.log('привет')"), timeoutMs: 20_000 }, p, {});
    expect(r.code).toBe(0);
    expect(r.stdout.split(/\r?\n/)[0].toLowerCase()).toBe(allowed.toLowerCase());
    expect(r.stdout).toContain("привет");
    expect(r.stderr.trim()).toBe("warn");
  });

  it("reports non-zero exit codes", async () => {
    const r = await execRun({ command: nodeCmd("process.exit(3)") }, p, {});
    expect(r.code).toBe(3);
  });

  it("caps output at 1 MB", async () => {
    const r = await execRun({ command: nodeCmd("process.stdout.write('x'.repeat(3*1024*1024))") }, p, {});
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(1024 * 1024);
    expect(r.stderr).toContain("truncated");
  });

  it("enforces the timeout and kills the whole process tree", async () => {
    const pidFile = join(allowed, "grandchild.pid");
    const grandchild = "setInterval(()=>{},1000)";
    const script =
      `const c=require('child_process').spawn(process.execPath,['-e','${grandchild}'],{stdio:'ignore'});` +
      `require('fs').writeFileSync('grandchild.pid',String(c.pid));setInterval(()=>{},1000)`;
    const started = Date.now();
    const r = await execRun({ command: nodeCmd(script), timeoutMs: 1500 }, p, {});
    expect(r.code).toBe(124);
    expect(r.stderr).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
  });

  it("caps the timeout with exec.maxTimeoutMs", async () => {
    const started = Date.now();
    const r = await execRun({ command: nodeCmd("setInterval(()=>{},1000)"), timeoutMs: 600_000 }, policy({ enabled: true, maxTimeoutMs: 1000 }), {});
    expect(r.code).toBe(124);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
