// latest.json for the desktop app's updater (src-tauri/src/update.rs reads it from the latest GitHub release):
//   node packaging/desktop/latest-json.mjs <dir with the release's files> <version> <owner/repo>
// Lists the signed update files build.mjs made: the universal macOS app for both Mac architectures and the Windows
// installer. Writes <dir>/latest.json; fails when a file or its signature is missing.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function latestJson(dir, version, repo, now = new Date()) {
  const asset = (name) => {
    const file = join(dir, name);
    if (!existsSync(file) || !existsSync(`${file}.sig`)) throw new Error(`missing ${name} or its .sig in ${dir}`);
    return { signature: readFileSync(`${file}.sig`, "utf8").trim(), url: `https://github.com/${repo}/releases/download/v${version}/${name}` };
  };
  const mac = asset(`piomio-${version}-mac.app.tar.gz`);
  return {
    version,
    pub_date: now.toISOString(),
    platforms: { "darwin-aarch64": mac, "darwin-x86_64": mac, "windows-x86_64": asset(`piomio-setup-${version}-x64.exe`) },
  };
}

if (import.meta.main) {
  const [dir, version, repo] = process.argv.slice(2);
  if (!dir || !version || !repo) throw new Error("usage: latest-json.mjs <dir> <version> <owner/repo>");
  const out = join(dir, "latest.json");
  writeFileSync(out, JSON.stringify(latestJson(dir, version, repo), null, 2) + "\n");
  console.log(`wrote ${out}`);
}
