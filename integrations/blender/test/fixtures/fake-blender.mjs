// A stand-in for Blender: --version, background runs (the add-on check, extension build and install-file) and a
// window whose add-on answers every request with the scene. What it was asked is kept in FAKE_BLENDER_STATE.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

const file = process.env.FAKE_BLENDER_STATE;
const read = () => (file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { calls: [] });
const write = (s) => file && writeFileSync(file, JSON.stringify(s));
const a = process.argv.slice(2);
const s = read();
s.calls.push(a);
write(s);
const arg = (name) => a[a.indexOf(name) + 1];

if (a[0] === "--version") {
  console.log(`Blender ${process.env.FAKE_BLENDER_VERSION ?? "5.3.0"}`);
} else if (a.includes("--background") && a.includes("--python-expr")) {
  if (arg("--python-expr").includes("__PIOMIO_BLENDER__")) console.log("__PIOMIO_BLENDER__" + JSON.stringify({ online: false, ...s.addon }));
} else if (a.includes("extension") && a.includes("build")) {
  writeFileSync(arg("--output-filepath"), "zip");
} else if (a.includes("extension") && a.includes("install-file")) {
  write({ ...read(), addon: { module: "bl_ext.user_default.mcp", version: "1.0.3", enabled: true, port: Number(process.env.BLENDER_MCP_PORT), autostart: true } });
} else {
  write({ ...read(), window: process.pid });
  createServer((c) => (c.on("error", () => {}), c.end("Cube, Camera, Light\n"))).listen(Number(process.env.BLENDER_MCP_PORT), "127.0.0.1");
  setTimeout(() => process.exit(0), 60_000);
}
