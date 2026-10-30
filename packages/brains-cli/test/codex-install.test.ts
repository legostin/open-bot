// Which Codex runs (codex-install.ts): the newest of the one on PATH and the copies the ChatGPT / Codex apps carry.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appCodexes, codexChooser, compareVersions, newestCodex } from "../src/codex-install.ts";

const root = mkdtempSync(join(tmpdir(), "owl-codex-install-"));
const app = (name: string, version: string) => {
  const dir = join(root, name, "Contents", "Resources", "codex-cli");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "codex"), "#!/bin/sh\n");
  writeFileSync(join(dir, "codex-package.json"), JSON.stringify({ version, entrypoint: "bin/codex" }));
  return dir;
};
const onPath = (version: string) => {
  const file = join(root, `codex-${version}`);
  writeFileSync(file, `#!/bin/sh\necho "codex-cli ${version}"\n`, { mode: 0o755 });
  return file;
};

describe("the newest Codex on this machine", () => {
  it("compares versions, a release above its own pre-release", () => {
    expect(compareVersions("codex-cli 0.165.0-alpha.1.2", "codex-cli 0.153.4")).toBeGreaterThan(0);
    expect(compareVersions("0.165.0", "0.165.0-alpha.1")).toBeGreaterThan(0);
    expect(compareVersions("0.99.0", "0.153.4")).toBeLessThan(0);
    expect(compareVersions("1.0.0", undefined)).toBeGreaterThan(0);
  });

  it("takes the app's copy when the one on PATH is older, and the one on PATH when it is newer", () => {
    const apps = appCodexes([app("ChatGPT.app", "0.165.0-alpha.1.2"), join(root, "Missing.app")]);
    expect(apps).toEqual([{ command: join(root, "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex"), version: "0.165.0-alpha.1.2" }]);
    expect(newestCodex(onPath("0.153.4"), apps)).toBe(apps[0].command);
    expect(newestCodex(onPath("0.166.0"), apps)).toBe(join(root, "codex-0.166.0"));
    expect(newestCodex(join(root, "no-codex"), apps)).toBe(apps[0].command);
    expect(newestCodex("codex", [])).toBe("codex");
  });

  it("keeps a command a setting names, and chooses only for none or the default", () => {
    expect(codexChooser("darwin")("/opt/codex/bin/codex")).toBe("/opt/codex/bin/codex");
    expect(codexChooser("linux")("codex")).toBe("codex");
    expect(codexChooser("linux")(undefined)).toBe("codex");
  });
});
