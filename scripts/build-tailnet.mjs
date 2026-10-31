// Builds piomio-tailnet, the hub's own Tailscale node (packages/tailnet, Go), into
// packages/tailnet/bin/<platform>-<arch>/piomio-tailnet[.exe] — the names Node's process.platform/arch use.
//   node scripts/build-tailnet.mjs            this computer's platform
//   node scripts/build-tailnet.mjs --all      every platform Piomio ships
//   node scripts/build-tailnet.mjs --target darwin-arm64 --target win32-x64
// Needs Go; the module asks for its own toolchain version, which Go downloads by itself.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "packages/tailnet");

export const TARGETS = ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64", "linux-arm64"];
const GOOS = { darwin: "darwin", win32: "windows", linux: "linux" };
const GOARCH = { arm64: "arm64", x64: "amd64" };

export function binaryPath(target) {
  return join(pkg, "bin", target, target.startsWith("win32") ? "piomio-tailnet.exe" : "piomio-tailnet");
}

const { values } = parseArgs({ options: { all: { type: "boolean" }, target: { type: "string", multiple: true } } });
const targets = values.all ? TARGETS : values.target?.length ? values.target : [`${process.platform}-${process.arch}`];

try {
  execFileSync("go", ["version"], { stdio: "ignore" });
} catch {
  console.error("build-tailnet: Go is not installed (https://go.dev/dl/). Without it access from anywhere is unavailable.");
  process.exit(1);
}

for (const target of targets) {
  const [platform, arch] = target.split("-");
  if (!GOOS[platform] || !GOARCH[arch]) throw new Error(`build-tailnet: unknown target ${target} (${TARGETS.join(", ")})`);
  const out = binaryPath(target);
  mkdirSync(dirname(out), { recursive: true });
  execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", out, "."], {
    cwd: pkg,
    stdio: "inherit",
    env: { ...process.env, CGO_ENABLED: "0", GOOS: GOOS[platform], GOARCH: GOARCH[arch], GOTOOLCHAIN: process.env.GOTOOLCHAIN || "auto" },
  });
  console.log(`built ${out.slice(root.length + 1)}`);
}
