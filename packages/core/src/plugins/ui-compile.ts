// The UI module of a plugin being installed, compiled by the hub: an integration an agent made (or one copied from a
// folder) brings ui/src/index.tsx but no build, so the hub turns that one file into the file its manifest's `ui`
// names. One file only: its imports stay as they are (react and @owlbot/ui come from the page's import map), and
// `import type` goes away.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { transform } from "sucrase";

/** Compiles ui/src/index.(tsx|ts|jsx) into `uiEntry` when that file is missing; true when it wrote one. */
export function compilePluginUi(dir: string, uiEntry: string | undefined): boolean {
  if (!uiEntry || existsSync(uiEntry)) return false;
  const src = ["index.tsx", "index.ts", "index.jsx"].map((f) => join(dir, "ui", "src", f)).find((f) => existsSync(f));
  if (!src) return false;
  const code = transform(readFileSync(src, "utf8"), { transforms: ["typescript", "jsx"], jsxRuntime: "automatic", production: true, filePath: src }).code;
  mkdirSync(dirname(uiEntry), { recursive: true });
  writeFileSync(uiEntry, code);
  return true;
}
